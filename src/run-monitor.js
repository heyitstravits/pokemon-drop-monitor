import { createClient } from "@supabase/supabase-js";
import axios from "axios";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INCLUDE_TERMS = [
  "booster", "elite trainer", "etb", "collection", "tin", "ex box",
  "blister", "bundle", "premium", "trainer box", "tcg", "trading card",
  "scarlet", "violet", "prismatic", "surging sparks", "stellar crown",
  "destined rivals", "white flare", "black bolt"
];

const EXCLUDE_TERMS = [
  "shirt", "hoodie", "figure", "birthday", "plush", "toy", "costume",
  "backpack", "lunch", "pajama", "pillow", "blanket", "hat", "sock",
  "poster", "book", "mug", "pants", "chinese", "world championships",
  "world championship", "trick or trade", "lot 8", "lot", "25th anniversary", "sword shield",
  "sun moon", "xy evolutions"
];

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const chatIds = [
    process.env.TELEGRAM_CHAT_ID,
    process.env.TELEGRAM_CHAT_ID_2
  ].filter(Boolean);

  if (!token || chatIds.length === 0) return;

  for (const chatId of chatIds) {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        disable_web_page_preview: false
      }
    );
  }

  console.log(`Telegram message sent to ${chatIds.length} chat(s)`);
}

async function fetchPage(url) {
  return axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
      Accept: "application/json,text/html,*/*",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
}

function hasAny(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function shouldKeepProduct(name, url) {
  const text = `${name} ${url}`.toLowerCase();
  if (hasAny(text, EXCLUDE_TERMS)) return false;
  return hasAny(text, INCLUDE_TERMS);
}

function getPriority(name, url) {
  const text = `${name} ${url}`.toLowerCase();

  if (
    text.includes("booster bundle") ||
    text.includes("elite trainer") ||
    text.includes("etb") ||
    text.includes("booster display")
  ) return 100;

  if (
    text.includes("premium collection") ||
    text.includes("ultra premium") ||
    text.includes("upc") ||
    text.includes("prismatic") ||
    text.includes("destined rivals") ||
    text.includes("white flare") ||
    text.includes("black bolt")
  ) return 90;

  if (text.includes("collection") || text.includes("ex box") || text.includes("box")) return 80;
  if (text.includes("tin") || text.includes("battle box") || text.includes("build battle")) return 70;
  if (text.includes("booster pack")) return 60;
  if (text.includes("deck") || text.includes("world championship")) return 40;

  return 10;
}

function estimateMsrp(name) {
  const text = String(name || "").toLowerCase();
  if (text.includes("booster bundle")) return 26.94;
  if (text.includes("elite trainer") || text.includes("etb")) return 49.99;
  if (text.includes("premium collection")) return 59.99;
  if (text.includes("ultra premium") || text.includes("upc")) return 119.99;
  if (text.includes("booster display")) return 59.99;
  if (text.includes("booster box")) return 119.99;
  if (text.includes("tin")) return 24.99;
  if (text.includes("ex box")) return 21.99;
  if (text.includes("booster pack")) return 4.99;
  if (text.includes("blister")) return 12.99;
  if (text.includes("collection")) return 29.99;
  return null;
}

function cleanNameFromUrl(url) {
  try {
    const decoded = decodeURIComponent(url);

    const targetMatch =
      decoded.match(/\/p\/(.+?)\/-\/A-/) ||
      decoded.match(/\/product\/(.+?)(\?|$|\/)/);

    if (targetMatch) {
      return targetMatch[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    const bestBuyMatch = decoded.match(/\/site\/(.+?)\/[0-9]+\.p/);

    if (bestBuyMatch) {
      return bestBuyMatch[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    return "Pokemon TCG Product";
  } catch {
    return "Pokemon TCG Product";
  }
}

async function insertDiscovery({ retailer, productName, productUrl, price = null, seller = null }) {
  if (!shouldKeepProduct(productName, productUrl)) {
    console.log(`Skipped noisy product: ${productName}`);
    return;
  }

  const priority = getPriority(productName, productUrl);
  const msrp = estimateMsrp(productName);
  const priceVsMsrp = price && msrp ? Number((price / msrp).toFixed(2)) : null;

  const { data: existing } = await supabase
    .from("discovered_products")
    .select("id, times_seen")
    .eq("product_url", productUrl)
    .limit(1);

  if (existing?.length) {
  await supabase
    .from("discovered_products")
    .update({
      last_seen_at: new Date().toISOString(),
      times_seen: (existing[0].times_seen || 1) + 1
    })
    .eq("id", existing[0].id);

  return;
}

  const { error } = await supabase.from("discovered_products").insert({
  retailer,
  product_name: productName,
  product_url: productUrl,
  status: "discovered",
  added_to_watchlist: false,
  ignored: false,
  seller: seller || retailer,
  price,
  is_marketplace: false,
  msrp_estimate: msrp,
  price_vs_msrp: priceVsMsrp,
  priority,

  first_seen_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  times_seen: 1
});

  if (error) {
    console.error("Discovery insert error:", error.message);
    return;
  }

  console.log(`New ${retailer} discovery: ${productName} | Priority: ${priority}`);

  if (priority >= 90) {
    await sendTelegram(
      `✨ HIGH PRIORITY ${retailer.toUpperCase()} TCG PRODUCT

${productName}

Priority: ${priority}
Seller: ${seller || retailer}
Price: ${price ? `$${price}` : "Unknown"}

Open:
${productUrl}`
    );
  }
}

function extractTargetLinks(text) {
  const links = new Set();
  const fullRegex = /https:\/\/www\.target\.com\/p\/[^"'\\\s]+?\/-\/A-[0-9]+/g;
  const relativeRegex = /\/p\/[^"'\\\s]+?\/-\/A-[0-9]+/g;

  for (const m of String(text).match(fullRegex) || []) links.add(m.split("?")[0]);
  for (const m of String(text).match(relativeRegex) || []) links.add(`https://www.target.com${m.split("?")[0]}`);

  return [...links];
}

function findPriceNearUrl(text, url) {
  const slug = url.split("/p/")[1]?.split("/-/A-")[0];
  if (!slug) return null;
  const index = text.indexOf(slug);
  if (index === -1) return null;

  const nearby = text.slice(Math.max(0, index - 3000), index + 5000);
  const patterns = [
    /"current_retail"\s*:\s*([0-9]+(?:\.[0-9]+)?)/,
    /"formatted_current_price"\s*:\s*"\$([0-9]+(?:\.[0-9]{2})?)"/,
    /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/,
    /\$([0-9]+(?:\.[0-9]{2})?)/
  ];

  for (const p of patterns) {
    const match = nearby.match(p);
    if (match) return Number(match[1]);
  }
  return null;
}

async function discoverTargetProducts() {
  console.log("Starting Target discovery...");

  const urls = [
    "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&channel=WEB&count=24&default_purchasability_filter=true&include_sponsored=true&keyword=pokemon%20cards&offset=0&page=%2Fs%2Fpokemon%20cards&platform=desktop&pricing_store_id=1771&scheduled_delivery_store_id=1771&store_ids=1771%2C1768%2C1113%2C3374%2C1792&useragent=Mozilla%2F5.0&visitor_id=01787772E6FD0201B7D280AD0B9C2D6B",
    "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&channel=WEB&count=24&default_purchasability_filter=true&include_sponsored=true&keyword=pokemon%20tcg&offset=0&page=%2Fs%2Fpokemon%20tcg&platform=desktop&pricing_store_id=1771&scheduled_delivery_store_id=1771&store_ids=1771%2C1768%2C1113%2C3374%2C1792&useragent=Mozilla%2F5.0&visitor_id=01787772E6FD0201B7D280AD0B9C2D6B"
  ];

  for (const url of urls) {
    try {
      console.log(`Fetching Target URL: ${url}`);
      const res = await fetchPage(url);
      console.log(`Target fetch success: HTTP ${res.status}`);
      const products =
  res.data?.data?.search?.products ||
  res.data?.data?.search_response?.products ||
  res.data?.data?.product_summaries ||
  [];

console.log(`Found ${products.length} Target product objects`);

for (const product of products) {
  const isMarketplace = product?.item?.fulfillment?.is_marketplace === true;
  const vendorName = product?.item?.product_vendors?.[0]?.vendor_name || "Target";

  if (isMarketplace) {
    console.log(`Skipped Target marketplace seller: ${vendorName}`);
    continue;
  }

  const productUrl = product?.item?.enrichment?.buy_url;
  const productName = product?.item?.product_description?.title || cleanNameFromUrl(productUrl);
  const price = product?.price?.current_retail ?? null;

  if (!productUrl || !productName) {
    console.log("Skipped Target product with missing URL/name");
    continue;
  }

  await insertDiscovery({
    retailer: "Target",
    productName,
    productUrl,
    price,
    seller: vendorName
  });

  await new Promise((r) => setTimeout(r, 500));
}
    } catch (err) {
  console.error(`Target discovery failed: ${err.message}`);
  console.error(`Target failed status: ${err.response?.status || "no-status"}`);
  console.error(`Target failed URL: ${url}`);
}
  }
}

function extractPokemonCenterLinks(text) {
  const links = new Set();

  const fullRegex = /https:\/\/www\.pokemoncenter\.com\/product\/[^"'\\\s]+/g;
  const relativeRegex = /\/product\/[^"'\\\s]+/g;

  for (const m of String(text).match(fullRegex) || []) {
    links.add(m.split("?")[0]);
  }

  for (const m of String(text).match(relativeRegex) || []) {
    links.add(`https://www.pokemoncenter.com${m.split("?")[0]}`);
  }

  return [...links].filter((url) => {
    const lower = url.toLowerCase();
    return lower.includes("pokemon-tcg") || lower.includes("trading-card") || lower.includes("booster") || lower.includes("elite-trainer");
  });
}

async function discoverPokemonCenterProducts() {
  console.log("Starting Pokemon Center discovery...");

  const urls = [
    "https://www.pokemoncenter.com/category/trading-card-game",
    "https://www.pokemoncenter.com/search/pokemon-tcg",
    "https://www.pokemoncenter.com/search/booster-bundle",
    "https://www.pokemoncenter.com/search/elite-trainer-box"
  ];

  for (const url of urls) {
    try {
      console.log(`Checking Pokemon Center: ${url}`);

      const res = await fetchPage(url);
      const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      const links = extractPokemonCenterLinks(text);

      console.log(`Found ${links.length} Pokemon Center links`);

      for (const productUrl of links) {
        const productName = cleanNameFromUrl(productUrl);

        await insertDiscovery({
          retailer: "Pokemon Center",
          productName,
          productUrl,
          price: null,
          seller: "Pokemon Center"
        });

        await new Promise((r) => setTimeout(r, 750));
      }
    } catch (err) {
      console.error(`Pokemon Center discovery failed: ${err.message}`);
    }
  }

  console.log("Pokemon Center discovery completed");
}

function extractWalmartLinks(text) {
  const links = new Set();

  const fullRegex = /https:\/\/www\.walmart\.com\/ip\/[^"'\\\s]+\/[0-9]+/g;
  const relativeRegex = /\/ip\/[^"'\\\s]+\/[0-9]+/g;

  for (const m of String(text).match(fullRegex) || []) links.add(m.split("?")[0]);
  for (const m of String(text).match(relativeRegex) || []) links.add(`https://www.walmart.com${m.split("?")[0]}`);

  return [...links].filter((url) => {
    const lower = url.toLowerCase();
    return lower.includes("pokemon");
  });
}

async function discoverWalmartProducts() {
  console.log("Starting Walmart discovery...");

  const urls = [
    "https://www.walmart.com/search?q=pokemon%20cards",
    "https://www.walmart.com/search?q=pokemon%20tcg",
    "https://www.walmart.com/search?q=pokemon%20elite%20trainer%20box",
    "https://www.walmart.com/search?q=pokemon%20booster%20bundle"
  ];

  for (const url of urls) {
    try {
      console.log(`Checking Walmart: ${url}`);

      const res = await fetchPage(url);
      const html = String(res.data || "");
      const links = extractWalmartLinks(html);

      console.log(`Found ${links.length} Walmart links`);

      for (const productUrl of links) {
        const productName = cleanNameFromUrl(productUrl);

        await insertDiscovery({
          retailer: "Walmart",
          productName,
          productUrl,
          price: null,
          seller: "Walmart"
        });

        await new Promise((r) => setTimeout(r, 750));
      }
    } catch (err) {
      console.error(`Walmart discovery failed: ${err.message}`);
    }
  }

  console.log("Walmart discovery completed");
}

async function discoverBestBuyProducts() {
  console.log("Starting Best Buy discovery...");

  const urls = [
    "https://www.bestbuy.com/site/searchpage.jsp?st=pokemon%20cards",
    "https://www.bestbuy.com/site/searchpage.jsp?st=pokemon%20tcg",
    "https://www.bestbuy.com/site/searchpage.jsp?st=pokemon%20booster"
  ];

  for (const url of urls) {
    try {
      console.log(`Checking Best Buy: ${url}`);

      const res = await fetchPage(url);
      const html = String(res.data || "");

      console.log(`Best Buy response length: ${html.length}`);
      const apiMatches = html.match(/api[^"'<> ]+/gi);

console.log("Best Buy API matches:");
console.log(apiMatches ? apiMatches.slice(0, 50) : "NONE");

      const links = new Set();

      const rawPatterns = [
        /https:\/\/www\.bestbuy\.com\/site\/[^"'<>\\\s]+?\/[0-9]+\.p/g,
        /\/site\/[^"'<>\\\s]+?\/[0-9]+\.p/g,
        /\\u002Fsite\\u002F[^"'<>\\\s]+?\\u002F[0-9]+\.p/g,
        /\\\/site\\\/[^"'<>\\\s]+?\\\/[0-9]+\.p/g,
        /"href"\s*:\s*"([^"]*site[^"]*?[0-9]+\.p[^"]*)"/g,
        /"url"\s*:\s*"([^"]*site[^"]*?[0-9]+\.p[^"]*)"/g
      ];

      for (const pattern of rawPatterns) {
        const matches = [...html.matchAll(pattern)];

        for (const match of matches) {
          let raw = match[1] || match[0];

          raw = raw
            .replace(/\\u002F/g, "/")
            .replace(/\\\//g, "/")
            .replace(/\\/g, "")
            .split("?")[0];

          if (raw.startsWith("https://www.bestbuy.com/site/")) {
            links.add(raw);
          } else if (raw.startsWith("/site/")) {
            links.add(`https://www.bestbuy.com${raw}`);
          }
        }
      }

      const filteredLinks = [...links].filter((productUrl) => {
        const lower = productUrl.toLowerCase();
        return (
          lower.includes("pokemon") &&
          lower.includes("bestbuy.com/site") &&
          lower.endsWith(".p")
        );
      });

      console.log(`Found ${filteredLinks.length} Best Buy Pokemon links`);

      for (const productUrl of filteredLinks) {
        const productName = cleanNameFromUrl(productUrl);

        await insertDiscovery({
          retailer: "Best Buy",
          productName,
          productUrl,
          price: null,
          seller: "Best Buy"
        });

        await new Promise((r) => setTimeout(r, 750));
      }
    } catch (err) {
      console.error(`Best Buy discovery failed: ${err.message}`);
    }
  }

  console.log("Best Buy discovery completed");
}

async function getPreviousStatus(productId) {
  const { data } = await supabase
    .from("stock_checks")
    .select("status, is_cartable, checked_at")
    .eq("product_id", productId)
    .order("checked_at", { ascending: false })
    .limit(1);

  return data?.[0] || null;
}

async function checkProduct(product) {
  try {
    const res = await fetchPage(product.product_url);
    const html = String(res.data || "").toLowerCase();

    let status = "out_of_stock";
    let isCartable = false;

    if (
      html.includes("add to cart") ||
      html.includes("add for shipping") ||
      html.includes("ship it") ||
      html.includes("add to bag")
    ) {
      status = "cartable";
      isCartable = true;
    } else if (html.includes("coming soon") || html.includes("preorder") || html.includes("pre-order")) {
      status = "coming_soon";
    }

    const priceMatch = String(res.data || "").match(/\$([0-9]+(?:\.[0-9]{2})?)/);
    const price = priceMatch ? Number(priceMatch[1]) : product.target_price || null;

    return {
      status,
      isCartable,
      price,
      rawMessage: `Checked page. HTTP ${res.status}. Detected ${status}.`
    };
  } catch (err) {
    return {
      status: "error",
      isCartable: false,
      price: product.target_price || null,
      rawMessage: err.message
    };
  }
}

async function monitorWatchlist() {
  console.log("Starting watchlist monitor...");

  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .eq("active", true);

  if (error) throw error;

  console.log(`Found ${products.length} watchlist products`);

  for (const product of products) {
    try {
      const previous = await getPreviousStatus(product.id);
      const result = await checkProduct(product);

      await supabase.from("stock_checks").insert({
        product_id: product.id,
        status: result.status,
        price: result.price,
        is_cartable: result.isCartable,
        raw_message: result.rawMessage
      });

      const wasCartable = previous?.is_cartable === true;
      const becameCartable = !wasCartable && result.isCartable === true;

      if (becameCartable) {
        await sendTelegram(
          `🚨 CARTABLE NOW

${product.name}

Retailer: ${product.retailer}
Price: ${result.price ? `$${result.price}` : "Unknown"}

Open:
${product.product_url}`
        );
      } else {
        console.log(`No alert sent for ${product.name}`);
      }
    } catch (err) {
      console.error(`Error checking ${product.name}:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function runDiscoveryForRetailer(retailer) {
  const startedAt = new Date().toISOString();

  let productsFound = 0;
  let productsAdded = 0;
  let errors = null;
  let status = "success";

  try {
    const before = await supabase
      .from("discovered_products")
      .select("id", { count: "exact", head: true });

    const beforeCount = before.count || 0;

    if (retailer.name === "Target") {
  await discoverTargetProducts();
} else if (retailer.name === "Pokemon Center") {
  await discoverPokemonCenterProducts();
} else if (retailer.name === "Best Buy") {
  await discoverBestBuyProducts();
} else if (retailer.name === "Walmart") {
  await discoverWalmartProducts();
} else {
  console.log(`No discovery function yet for ${retailer.name}`);
  status = "skipped";
}

    const after = await supabase
      .from("discovered_products")
      .select("id", { count: "exact", head: true });

    const afterCount = after.count || 0;
    productsAdded = Math.max(0, afterCount - beforeCount);
    productsFound = productsAdded;
  } catch (err) {
    errors = err.message;
    status = "failed";
    console.error(`Discovery failed for ${retailer.name}:`, err.message);
  }

  await supabase.from("discovery_logs").insert({
    retailer: retailer.name,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    products_found: productsFound,
    products_added: productsAdded,
    errors,
    status
  });
}

async function runDiscovery() {
  console.log("Checking retailer discovery settings...");

  const { data: retailers, error } = await supabase
    .from("retailers")
    .select("*")

  if (error) {
    console.error("Failed to load retailers:", error.message);
    return;
  }

  for (const retailer of retailers || []) {
  const retailerEnabled =
    retailer.enabled === true ||
    retailer.active === true;

  const discoveryOn =
    retailerEnabled === true &&
    retailer.discovery_enabled === true;

    if (!discoveryOn) {
      console.log(`Discovery disabled for ${retailer.name}`);
      continue;
    }

    console.log(`Discovery enabled for ${retailer.name}`);
    await runDiscoveryForRetailer(retailer);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function run() {
  console.log("Starting monitor...");

  await monitorWatchlist();
  await runDiscovery();

  console.log("Monitor completed");
}

run();
