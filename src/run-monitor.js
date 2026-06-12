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

      // TEST STATUS FOR NOW
      // Later we will replace this with real website checking.
      const currentStatus = "cartable";
      const currentPrice = product.target_price;
      const currentIsCartable = true;

      const { error: insertError } = await supabase.from("stock_checks").insert({
        product_id: product.id,
        status: currentStatus,
        price: currentPrice,
        is_cartable: currentIsCartable,
        raw_message: "GitHub monitor test with status-change alert"
      });

      if (insertError) {
        throw insertError;
      }

      const wasCartable = previous?.is_cartable === true;
      const becameCartable = !wasCartable && currentIsCartable === true;

      if (becameCartable) {
        await sendTelegram(
          `🚨 CARTABLE NOW

${product.name}

Retailer: ${product.retailer}
Price: $${currentPrice}

Open:
${product.product_url}`
        );
      } else {
        console.log(
          `No alert sent. Previous cartable: ${wasCartable}, current cartable: ${currentIsCartable}`
        );
      }

      console.log(`Finished ${product.name}`);
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
