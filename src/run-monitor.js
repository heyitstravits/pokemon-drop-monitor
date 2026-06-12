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

async function fetchPage(url) {
  return await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
      Accept: "application/json,text/html,*/*",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
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

    const response = await fetchPage(product.product_url);
    const html = String(response.data || "");
    const lowerHtml = html.toLowerCase();

    let status = "out_of_stock";
    let isCartable = false;

    if (
      lowerHtml.includes("add to cart") ||
      lowerHtml.includes("add for shipping") ||
      lowerHtml.includes("ship it") ||
      lowerHtml.includes("ready within")
    ) {
      status = "cartable";
      isCartable = true;
    } else if (
      lowerHtml.includes("coming soon") ||
      lowerHtml.includes("preorder") ||
      lowerHtml.includes("pre-order")
    ) {
      status = "coming_soon";
    } else if (
      lowerHtml.includes("out of stock") ||
      lowerHtml.includes("sold out") ||
      lowerHtml.includes("currently unavailable") ||
      lowerHtml.includes("not available")
    ) {
      status = "out_of_stock";
    }

    const priceMatch = html.match(/\$([0-9]+(?:\.[0-9]{2})?)/);
    const price = priceMatch
      ? Number(priceMatch[1])
      : product.target_price || null;

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

function extractTargetLinksFromText(text) {
  const links = new Set();

  const fullRegex =
    /https:\/\/www\.target\.com\/p\/[^"'\\\s]+?\/-\/A-[0-9]+/g;

  const relativeRegex = /\/p\/[^"'\\\s]+?\/-\/A-[0-9]+/g;

  for (const match of text.match(fullRegex) || []) {
    links.add(match.split("?")[0]);
  }

  for (const match of text.match(relativeRegex) || []) {
    links.add(`https://www.target.com${match.split("?")[0]}`);
  }

  return [...links];
}

function cleanProductNameFromUrl(url) {
  try {
    const match = url.match(/\/p\/(.+?)\/-\/A-/);
    if (!match) return "Target Pokémon Product";

    return match[1]
      .replace(/-/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  } catch {
    return "Target Pokémon Product";
  }
}

async function insertDiscovery(productName, productUrl) {
  const { data: existing, error: existingError } = await supabase
    .from("discovered_products")
    .select("id")
    .eq("product_url", productUrl)
    .limit(1);

  if (existingError) {
    console.error("Discovery lookup error:", existingError.message);
    return;
  }

  if (existing && existing.length > 0) {
    return;
  }

  const { error } = await supabase.from("discovered_products").insert({
    retailer: "Target",
    product_name: productName,
    product_url: productUrl,
    status: "discovered",
    added_to_watchlist: false,
    ignored: false
  });

  if (error) {
    console.error("Discovery insert error:", error.message);
    return;
  }

  console.log(`New Target discovery: ${productName}`);

  await sendTelegram(
    `✨ NEW TARGET PRODUCT FOUND

${productName}

Retailer: Target

Open:
${productUrl}

Go to your Discovery page to add it to Watchlist.`
  );
}

async function discoverTargetProducts() {
  console.log("Starting Target discovery...");

  const urlsToTry = [
    "https://www.target.com/s?searchTerm=pokemon%20cards",
    "https://www.target.com/s?searchTerm=pokemon%20tcg",
    "https://www.target.com/s?searchTerm=pokemon%20booster",
    "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&channel=WEB&count=24&default_purchasability_filter=true&include_sponsored=true&keyword=pokemon%20cards&offset=0&page=%2Fs%2Fpokemon%20cards&platform=desktop&pricing_store_id=1771&scheduled_delivery_store_id=1771&store_ids=1771%2C1768%2C1113%2C3374%2C1792&useragent=Mozilla%2F5.0&visitor_id=01787772E6FD0201B7D280AD0B9C2D6B"
  ];

  for (const url of urlsToTry) {
    try {
      console.log(`Discovering from: ${url}`);

      const response = await fetchPage(url);
      const text =
        typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data);

      console.log(`Discovery HTTP ${response.status}, response length ${text.length}`);

      const links = extractTargetLinksFromText(text);

      console.log(`Found ${links.length} Target product links`);

      for (const productUrl of links) {
        const productName = cleanProductNameFromUrl(productUrl);

        await insertDiscovery(productName, productUrl);

        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    } catch (err) {
      console.error(`Target discovery failed: ${err.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log("Target discovery completed");
}

async function monitorWatchlist() {
  console.log("Starting watchlist monitor...");

  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("Supabase error:", error);
    process.exit(1);
  }

  console.log(`Found ${products.length} watchlist products`);

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

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log("Watchlist monitor completed");
}

async function run() {
  console.log("Starting monitor...");

  await discoverTargetProducts();
  await monitorWatchlist();

  console.log("Monitor completed");
}

run();
