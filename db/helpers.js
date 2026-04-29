import { supabase } from "./client.js";

export async function upsertUser({ telegram_id, username, wallet_address = null }) {
  const { data, error } = await supabase
    .from("users")
    .upsert(
      { telegram_id: String(telegram_id), username, wallet_address, last_seen: new Date().toISOString() },
      { onConflict: "telegram_id" }
    )
    .select()
    .single();

  if (error) throw error;
  return data; // returns user row {id,...}
}
export async function createMatch({ player1_id, player2_id, stake_amount }) {
  const { data, error } = await supabase
    .from("matches")
    .insert({
      player1_id,
      player2_id,
      stake_amount,
      status: "active",
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return data; // match row with id
}
export async function finishMatch({ match_id, winner_id }) {
  const { data, error } = await supabase
    .from("matches")
    .update({
      status: "finished",
      winner_id,
      ended_at: new Date().toISOString(),
    })
    .eq("id", match_id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
