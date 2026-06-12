import { createClient } from "@supabase/supabase-js";
import axios from "axios";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log(`Found ${products.length} products`);

  for (const product of products) {
    console.log(`Checking ${product.name}`);

    await supabase.from("stock_checks").insert({
      product_id: product.id,
      status: "cartable",
      price: product.target_price,
      is_cartable: true,
      raw_message: "GitHub monitor test"
    });
  }
}

run();
