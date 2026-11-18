import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";
import { listAudit } from "@/server/audit";
import { db } from "@/server/db/client";

function formatWhen(value: unknown) {
  if (value instanceof Date) return value.toLocaleString("en-KE");
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("en-KE");
}

export default async function AdminPage() {
  const staff = await requireScreen(["admin"]);
  const events = await listAudit(db, staff.facilityId, 20);

  return (
    <Screen
      title="Administration"
      description="Staff, facilities, catalogues and audit activity."
      testId="screen-admin"
    >
      <div className="overflow-hidden border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Recent audit events</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Authentication and administrative writes for the active facility.
          </p>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/50 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            <tr>
              <th className="px-5 py-2">When</th>
              <th className="px-5 py-2">Action</th>
              <th className="px-5 py-2">Entity</th>
              <th className="px-5 py-2">User</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-5 py-6 text-center text-muted-foreground">
                  No audit events yet.
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={String(event.id)} className="border-b border-border last:border-0">
                  <td className="px-5 py-2 font-mono text-xs tabular-nums">
                    {formatWhen(event.created_at)}
                  </td>
                  <td className="px-5 py-2">{String(event.action)}</td>
                  <td className="px-5 py-2">{String(event.entity)}</td>
                  <td className="px-5 py-2 font-mono text-xs">{String(event.user_id ?? "—")}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Screen>
  );
}
