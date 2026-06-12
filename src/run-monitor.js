import { createClient } from "@supabase/supabase-js";
import axios from "axios";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram credentials missing");
    return;
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: false
  });

  console.log("Telegram message sent");
}

async function getPreviousStatus(productId) {
  const { data, error } = await supabase
    .from("stock_checks")
    .select("status, is_cartable, checked_at")
    .eq("product_id", productId)
    .order("checked_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Previous status error:", error);
    return null;
  }

  return data?.[0] || null;
}

async function checkTargetProduct(product) {
  try {
    console.log(`Loading Target page: ${product.product_url}`);

    const response = await axios.get(product.product_url, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const html = String(response.data || "");
    const lowerHtml = html.toLowerCase();

    let status = "out_of_stock";
    let isCartable = false;

    const cartableWords = [
      "add to cart",
      "add for shipping",
      "ship it",
      "pickup",
      "ready within"
    ];

    const outOfStockWords = [
      "out of stock",
      "sold out",
      "currently unavailable",
      "not available"
    ];

    const comingSoonWords = [
      "coming soon",
      "preorder",
      "pre-order"
    ];

    if (cartableWords.some((word) => lowerHtml.includes(word))) {
      status = "cartable";
      isCartable = true;
    } else if (comingSoonWords.some((word) => lowerHtml.includes(word))) {
      status = "coming_soon";
    } else if (outOfStockWords.some((word) => lowerHtml.includes(word))) {
      status = "out_of_stock";
    }

    const priceMatch = html.match(/\$([0-9]+(?:\.[0-9]{2})?)/);
    const price = priceMatch ? Number(priceMatch[1]) : product.target_price || null;

    return {
      status,
      isCartable,
      price,
      rawMessage: `Target page checked. HTTP ${response.status}. Detected ${status}.`
    };
  } catch (err) {
    return {
      status: "error",
      isCartable: false,
      price: product.target_price || null,
      rawMessage: `Target check failed: ${err.message}`
    };
  }
}

async function checkProduct(product) {
  if ((product.retailer || "").toLowerCase().includes("target")) {
    return await checkTargetProduct(product);
  }

  return {
    status: "unknown",
    isCartable: false,
    price: product.target_price || null,
    rawMessage: `No checker built yet for retailer: ${product.retailer}`
  };
}

async function run() {
  console.log("Starting monitor...");

  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("Supabase error:", error);
    process.exit(1);
  }

  console.log(`Found ${products.length} products`);

  for (const product of products) {
    try {
      console.log(`Checking ${product.name}`);

      const previous = await getPreviousStatus(product.id);
      const result = await checkProduct(product);

      const { error: insertError } = await supabase.from("stock_checks").insert({
        product_id: product.id,
        status: result.status,
        price: result.price,
        is_cartable: result.isCartable,
        raw_message: result.rawMessage
      });

      if (insertError) throw insertError;

      const wasCartable = previous?.is_cartable === true;
      const becameCartable = !wasCartable && result.isCartable === true;

      if (becameCartable) {
        await sendTelegram(
          `🚨 CARTABLE NOW

${product.name}

Retailer: ${product.retailer}
Price: $${result.price}

Open:
${product.product_url}`
        );
      } else {
        console.log(
          `No alert sent. Previous cartable: ${wasCartable}, current cartable: ${result.isCartable}`
        );
      }

      console.log(`Finished ${product.name}: ${result.status}`);
    } catch (err) {
      console.error(`Error checking ${product.name}:`, err.message);

      await supabase.from("stock_checks").insert({
        product_id: product.id,
        status: "error",
        is_cartable: false,
        raw_message: err.message
      });
    }
  }

  console.log("Monitor completed");
}

run();
