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

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: message
      }
    );

    console.log("Telegram message sent");
  } catch (error) {
    console.error(
      "Telegram error:",
      error?.response?.data || error.message
    );
  }
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

      await supabase.from("stock_checks").insert({
        product_id: product.id,
        status: "cartable",
        price: product.target_price,
        is_cartable: true,
        raw_message: "GitHub monitor test"
      });

      await sendTelegram(
        `🚨 Pokémon Alert

${product.name}

Retailer: ${product.retailer}
Status: cartable
Price: $${product.target_price}

${product.product_url}`
      );

      console.log(`Finished ${product.name}`);
    } catch (err) {
      console.error(
        `Error checking ${product.name}:`,
        err.message
      );

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
