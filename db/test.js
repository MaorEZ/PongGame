import { supabase } from "./client.js";

async function test() {
  const { data, error } = await supabase
    .from("users")
    .insert({
      telegram_id: "111",
      username: "Maor"
    })
    .select();

  console.log("DATA:", data);
  console.log("ERROR:", error);
}

test();
