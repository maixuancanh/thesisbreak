import Link from "next/link";
import { Today } from "../../components/today";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.PICK_REVIEW_UI_ENABLED !== "true")
    return (
      <main id="main" className="page narrow">
        <h1>Today</h1>
        <p>The review inbox is not available in this workspace yet.</p>
        <Link className="text-link" href="/">
          Choose a market
        </Link>
      </main>
    );
  return (
    <Today
      accountabilityEnabled={
        process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true"
      }
    />
  );
}
