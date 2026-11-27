import { redirect } from "next/navigation";

// The leaderboard was retired. Old links land on Wrapped instead of a 404.
export default function LeaderboardPage() {
  redirect("/wrapped");
}
