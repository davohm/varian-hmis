"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { toast } from "sonner";

import {
  ADMIN_SECTION_META,
  ADMIN_SECTIONS,
  type AdminSection,
} from "@/lib/admin-sections";
import { Button } from "@/components/ui/button";
import { ErrorPanel } from "@/components/ui/error-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingPanel } from "@/components/ui/loading-panel";
import { cn } from "cn";

type Row = { id: string; active?: boolean; isActive?: boolean };

interface FacilityRow extends Row {
  code: string;
  name: string;
  county: string | null;
  writeAuthority: "cloud" | "clinic";
  active: boolean;
}

interface BranchRow extends Row {
  code: string;
  name: string;
  isMain: boolean;
  active: boolean;
}

interface DepartmentRow extends Row {
  branchId: string;
  name: string;
  kind: string;
  active: boolean;
}

interface RoomRow extends Row {
  departmentId: string;
  name: string;
  active: boolean;
}

interface StoreRow extends Row {
  branchId: string;
  name: string;
  kind: string;
  active: boolean;
}

interface StaffRow extends Row {
  userId: string;
  name: string;
  email: string;
  staffNumber: string;
  phone: string | null;
  isActive: boolean;
  role: string;
  facilityId: string;
  branchId: string | null;
}

interface CatalogRow extends Row {
  code: string;
  name: string;
  active: boolean;
  scope: string;
  kind?: string;
  unit?: string;
  defaultPrice?: string;
  sampleType?: string;
}

interface PriceListRow extends Row {
  name: string;
  payerType: string;
  active: boolean;
  priceCount: number;
}

interface PriceRow extends Row {
  priceListId: string;
  priceListName: string;
  targetType: string;
  targetId: string;
  targetName: string;
  amount: string;
  active: boolean;
  voidedAt: string | null;
}

interface AuditEvent extends Row {
  created_at: string;
  action: string;
  module: string;
  entity: string;
  entity_id: string | null;
  user_id: string | null;
  details: Record<string, unknown>;
}

interface AdminAccessRow {
  userId: string;
  name: string;
  email: string;
  sections: AdminSection[];
}

interface Overview {
  facilityId: string;
  sections: AdminSection[];
  facilities: FacilityRow[];
  setup: {
    branches: BranchRow[];
    departments: DepartmentRow[];
    rooms: RoomRow[];
    stores: StoreRow[];
  };
  staff: StaffRow[];
  adminAccess: AdminAccessRow[];
  catalogs: {
    items: CatalogRow[];
    labTests: CatalogRow[];
    services: CatalogRow[];
  };
  priceLists: PriceListRow[];
  prices: PriceRow[];
}

interface SyncStatus {
  appMode: "cloud" | "clinic";
  syncEnabled: boolean;
  pendingCount: number;
  oldestPendingSeconds: number | null;
  failedCount: number;
  lastSuccessAt: string | null;
  lastPulledAt: string | null;
  lastError: string | null;
}

interface FailedSyncRow {
  id: string;
  outboxId: string;
  tableName: string;
  recordId: string;
  operation: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  payloadPreview: string;
}

interface SyncMonitor {
  status: SyncStatus;
  failedRows: FailedSyncRow[];
}

type FieldValue = string | boolean;

interface Field {
  name: string;
  label: string;
  type?: "text" | "password" | "number" | "select" | "checkbox" | "textarea";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  full?: boolean;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function statusLabel(active: boolean | undefined) {
  return active === false ? "Inactive" : "Active";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => null)) as
    | { error?: string; detail?: string; issues?: Array<{ message?: string }>; result?: T }
    | null;
  if (!response.ok) {
    throw new Error(data?.issues?.[0]?.message ?? data?.detail ?? data?.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

async function postCommand<T>(command: string, input: Record<string, unknown>): Promise<T> {
  const data = await requestJson<{ result: T }>("/api/admin/commands", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "admin-station" },
    body: JSON.stringify({
      command,
      input: { ...compact(input), idempotencyKey: crypto.randomUUID() },
    }),
  });
  return data.result;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
}) {
  const id = `field-${field.name}`;
  const common = {
    id,
    name: field.name,
    disabled: field.disabled,
    "data-testid": `admin-field-${field.name}`,
  };

  return (
    <div className={cn("space-y-1", field.full && "sm:col-span-2")}>
      <Label htmlFor={id}>{field.label}</Label>
      {field.type === "select" ? (
        <select
          {...common}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/30"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          required={field.required}
        >
          <option value="">Select…</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" ? (
        <textarea
          {...common}
          className="min-h-20 w-full rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/30"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          required={field.required}
        />
      ) : field.type === "checkbox" ? (
        <label className="flex h-8 items-center gap-2 text-sm">
          <input
            {...common}
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="text-muted-foreground">{field.placeholder ?? "Enabled"}</span>
        </label>
      ) : (
        <Input
          {...common}
          type={field.type ?? "text"}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          required={field.required}
        />
      )}
    </div>
  );
}

function RecordForm({
  fields,
  initial,
  submitLabel,
  busy,
  testId,
  onSubmit,
  onCancel,
}: {
  fields: Field[];
  initial?: Record<string, FieldValue>;
  submitLabel: string;
  busy?: string | null;
  testId: string;
  onSubmit: (values: Record<string, FieldValue>) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>(initial ?? {});

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2" data-testid={testId}>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name] ?? (field.type === "checkbox" ? false : "")}
          onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
        />
      ))}
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={Boolean(busy)} data-testid={`${testId}-submit`}>
          {busy ?? submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function DataTable<T extends Row>({
  rows,
  columns,
  testId,
  empty = "No records yet.",
}: {
  rows: T[];
  columns: Array<{ key: string; label: string; render: (row: T) => ReactNode }>;
  testId: string;
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-6 text-center text-muted-foreground" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                {columns.map((column) => (
                  <td key={column.key} className="px-3 py-2 align-middle">
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Panel({
  title,
  description,
  testId,
  children,
}: {
  title: string;
  description: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" data-testid={testId}>
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function StatusBadge({ active }: { active: boolean | undefined }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs font-medium",
        active === false
          ? "bg-muted text-muted-foreground"
          : "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
      )}
    >
      {statusLabel(active)}
    </span>
  );
}

interface PanelProps {
  overview: Overview;
  busy: string | null;
  run: (label: string, command: string, input: Record<string, unknown>, success: string) => Promise<boolean>;
}

function FacilitySetupPanel({ overview, busy, run }: PanelProps) {
  const branches = overview.setup.branches;
  const departments = overview.setup.departments;
  const rooms = overview.setup.rooms;
  const stores = overview.setup.stores;

  const branchOptions = useMemo(
    () => branches.map((branch) => ({ value: branch.id, label: `${branch.code} — ${branch.name}` })),
    [branches],
  );
  const departmentOptions = useMemo(
    () => departments.map((department) => ({ value: department.id, label: department.name })),
    [departments],
  );
  const facilityOptions = useMemo(
    () => overview.facilities.map((facility) => ({ value: facility.id, label: `${facility.code} — ${facility.name}` })),
    [overview.facilities],
  );

  const [entity, setEntity] = useState<"facility" | "branch" | "department" | "room" | "store">("branch");
  const [editing, setEditing] = useState<Row | null>(null);
  const [formKey, setFormKey] = useState(0);

  const fields = useMemo<Field[]>(() => {
    const common: Field[] = [];
    if (entity === "facility") {
      common.push(
        { name: "name", label: "Facility name", required: !editing, full: true },
        { name: "county", label: "County" },
        { name: "phone", label: "Phone" },
        { name: "email", label: "Email" },
        {
          name: "writeAuthority",
          label: "Write authority",
          type: "select",
          options: [
            { value: "cloud", label: "Cloud" },
            { value: "clinic", label: "Clinic" },
          ],
        },
        { name: "timezone", label: "Timezone" },
      );
      if (!editing) common.unshift({ name: "code", label: "Facility code", required: true, placeholder: "FAM" });
      else common.unshift({ name: "id", label: "Facility", type: "select", options: facilityOptions, required: true, disabled: true });
    } else if (entity === "branch") {
      if (!editing) common.push({ name: "code", label: "Branch code", required: true });
      else common.push({ name: "id", label: "Branch", type: "select", options: branchOptions, required: true, disabled: true });
      common.push(
        { name: "name", label: "Branch name", required: !editing },
        { name: "isMain", label: "", type: "checkbox", placeholder: "Main branch" },
      );
    } else if (entity === "department") {
      if (!editing) common.push({
        name: "branchId", label: "Branch", type: "select", options: branchOptions, required: true,
      });
      else common.push({ name: "id", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })), required: true, disabled: true });
      common.push(
        { name: "name", label: "Department name", required: !editing },
        {
          name: "kind",
          label: "Kind",
          type: "select",
          options: ["opd", "triage", "reception", "lab", "pharmacy", "cashier", "admin", "other"].map((value) => ({ value, label: value })),
          required: !editing,
        },
      );
    } else if (entity === "room") {
      if (!editing) common.push({
        name: "departmentId", label: "Department", type: "select", options: departmentOptions, required: true,
      });
      else common.push({ name: "id", label: "Room", type: "select", options: rooms.map((r) => ({ value: r.id, label: r.name })), required: true, disabled: true });
      common.push({ name: "name", label: "Room name", required: !editing });
    } else {
      if (!editing) common.push({
        name: "branchId", label: "Branch", type: "select", options: branchOptions, required: true,
      });
      else common.push({ name: "id", label: "Store", type: "select", options: stores.map((s) => ({ value: s.id, label: s.name })), required: true, disabled: true });
      common.push(
        { name: "name", label: "Store name", required: !editing },
        {
          name: "kind",
          label: "Kind",
          type: "select",
          options: ["pharmacy", "main", "lab"].map((value) => ({ value, label: value })),
          required: !editing,
        },
      );
    }
    return common;
  }, [branchOptions, departmentOptions, departments, editing, entity, facilityOptions, rooms, stores]);

  const initial = useMemo<Record<string, FieldValue>>(() => {
    if (!editing) return {};
    const row = editing as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === "boolean" || typeof value === "string" ? value : ""]),
    );
  }, [editing]);

  const config = {
    facility: { create: "createFacility", update: "updateFacility", active: "setFacilityActive", id: "facilityId", label: "Facility" },
    branch: { create: "createBranch", update: "updateBranch", active: "setBranchActive", id: "branchId", label: "Branch" },
    department: { create: "createDepartment", update: "updateDepartment", active: "setDepartmentActive", id: "departmentId", label: "Department" },
    room: { create: "createRoom", update: "updateRoom", active: "setRoomActive", id: "roomId", label: "Room" },
    store: { create: "createStore", update: "updateStore", active: "setStoreActive", id: "storeId", label: "Store" },
  }[entity];

  async function submit(values: Record<string, FieldValue>) {
    const input = compact(values);
    const ok = await run(
      "Saving…",
      editing ? config.update : config.create,
      input,
      `${config.label} ${editing ? "updated" : "created"}.`,
    );
    if (ok) {
      setEditing(null);
      setFormKey((key) => key + 1);
    }
  }

  const activeCommand = config.active;
  const toggleActive = useCallback(
    async (row: Row, active: boolean) => {
      await run("Updating…", activeCommand, { id: row.id, active }, `${config.label} ${active ? "activated" : "deactivated"}.`);
    },
    [activeCommand, config.label, run],
  );

  const rows: Row[] =
    entity === "facility" ? overview.facilities
      : entity === "branch" ? branches
        : entity === "department" ? departments
          : entity === "room" ? rooms : stores;

  const columns = useMemo(() => {
    const base: Array<{ key: string; label: string; render: (row: Row) => ReactNode }> = [
      { key: "name", label: "Name", render: (row) => <span className="font-medium">{(row as unknown as { name: string }).name}</span> },
      { key: "status", label: "Status", render: (row) => <StatusBadge active={row.active} /> },
      {
        key: "actions",
        label: "Actions",
        render: (row) => (
          <div className="flex gap-1">
            <Button type="button" size="xs" variant="outline" onClick={() => { setEditing(row); setFormKey((key) => key + 1); }}>
              Edit
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={row.active === false || (entity === "branch" && (row as BranchRow).isMain)}
              onClick={() => void toggleActive(row, false)}
            >
              Deactivate
            </Button>
            {row.active === false ? (
              <Button type="button" size="xs" variant="ghost" onClick={() => void toggleActive(row, true)}>
                Activate
              </Button>
            ) : null}
          </div>
        ),
      },
    ];
    if (entity === "facility") {
      base.unshift({ key: "code", label: "Code", render: (row) => <span className="font-mono text-xs">{(row as FacilityRow).code}</span> });
    } else if (entity === "branch") {
      base.unshift({ key: "code", label: "Code", render: (row) => <span className="font-mono text-xs">{(row as BranchRow).code}</span> });
    } else if (entity === "department") {
      base.unshift({ key: "kind", label: "Kind", render: (row) => (row as DepartmentRow).kind });
    } else if (entity === "store") {
      base.unshift({ key: "kind", label: "Kind", render: (row) => (row as StoreRow).kind });
    }
    return base;
  }, [entity, toggleActive]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="Facility structure" description="Branches, departments, rooms and stores for the active facility." testId="admin-setup-list">
        <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Facility setup entity">
          {(["facility", "branch", "department", "room", "store"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              role="tab"
              size="sm"
              variant={entity === value ? "default" : "outline"}
              aria-selected={entity === value}
              data-testid={`admin-setup-tab-${value}`}
              onClick={() => { setEntity(value); setEditing(null); setFormKey((key) => key + 1); }}
            >
              {value[0].toUpperCase() + value.slice(1)}s
            </Button>
          ))}
        </div>
        <DataTable rows={rows} columns={columns} testId={`admin-setup-rows-${entity}`} />
      </Panel>
      <Panel title={editing ? `Edit ${entity}` : `New ${entity}`} description="Changes are audited and idempotent." testId="admin-setup-form-panel">
        <RecordForm
          key={`${entity}-${formKey}`}
          fields={fields}
          initial={initial}
          submitLabel={editing ? `Update ${entity}` : `Create ${entity}`}
          busy={busy}
          testId="admin-setup-form"
          onSubmit={(values) => void submit(values)}
          onCancel={editing ? () => { setEditing(null); setFormKey((key) => key + 1); } : undefined}
        />
      </Panel>
    </div>
  );
}

function AdminAccessPanel({ overview, busy, run }: PanelProps) {
  const [userId, setUserId] = useState("");
  const [sections, setSections] = useState<AdminSection[]>([]);
  const admins = overview.adminAccess;

  useEffect(() => {
    const initial = admins.find((admin) => admin.userId === userId) ?? admins[0];
    setUserId(initial?.userId ?? "");
    setSections(initial?.sections ?? []);
  }, [admins, userId]);

  function toggle(section: AdminSection) {
    setSections((current) =>
      current.includes(section)
        ? current.filter((item) => item !== section)
        : [...current, section],
    );
  }

  async function save() {
    if (!userId) return;
    await run(
      "Saving access…",
      "setAdminSectionAccess",
      { userId, sections },
      "Administration access updated.",
    );
  }

  return (
    <Panel
      title="Administration access"
      description="Limit an administrator to specific sections. No selection keeps full access."
      testId="admin-access-panel"
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="admin-access-user">Administrator</Label>
          <select
            id="admin-access-user"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
            value={userId}
            data-testid="admin-access-user"
            onChange={(event) => setUserId(event.target.value)}
          >
            {admins.length === 0 ? <option value="">No administrators</option> : null}
            {admins.map((admin) => (
              <option key={admin.userId} value={admin.userId}>
                {admin.name} ({admin.email})
              </option>
            ))}
          </select>
        </div>
        <fieldset className="grid gap-2" data-testid="admin-access-sections">
          <legend className="mb-1 text-sm font-medium">Permitted sections</legend>
          {ADMIN_SECTIONS.map((section) => (
            <label key={section} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={sections.includes(section)}
                data-testid={`admin-access-section-${section}`}
                onChange={() => toggle(section)}
              />
              {ADMIN_SECTION_META[section].label}
            </label>
          ))}
        </fieldset>
        <Button
          type="button"
          size="sm"
          disabled={!userId || busy !== null}
          data-testid="admin-access-save"
          onClick={() => void save()}
        >
          {busy === "Saving access…" ? "Saving…" : "Save access"}
        </Button>
      </div>
    </Panel>
  );
}

function StaffPanel({ overview, busy, run }: PanelProps) {
  const facilityOptions = useMemo(
    () => overview.facilities.map((facility) => ({ value: facility.id, label: `${facility.code} — ${facility.name}` })),
    [overview.facilities],
  );
  const branchOptions = useMemo(
    () => overview.setup.branches.map((branch) => ({ value: branch.id, label: branch.name })),
    [overview.setup.branches],
  );
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [formKey, setFormKey] = useState(0);

  const createFields = useMemo<Field[]>(() => [
    { name: "name", label: "Full name", required: true, full: true },
    { name: "email", label: "Work email", required: true },
    { name: "staffNumber", label: "Staff number", required: true },
    { name: "password", label: "Temporary password", type: "password", required: true },
    { name: "phone", label: "Phone" },
    {
      name: "role",
      label: "Role",
      type: "select",
      required: true,
      options: ["receptionist", "triage_nurse", "doctor", "lab_tech", "pharmacist", "cashier", "admin"].map((value) => ({ value, label: value })),
    },
    { name: "facilityId", label: "Facility scope", type: "select", required: true, options: facilityOptions },
    { name: "branchId", label: "Branch scope (blank = all)", type: "select", options: branchOptions },
  ], [branchOptions, facilityOptions]);

  const editFields = useMemo<Field[]>(() => [
    { name: "name", label: "Full name", required: true, full: true },
    { name: "phone", label: "Phone" },
  ], []);

  async function create(values: Record<string, FieldValue>) {
    const { role, facilityId, branchId, ...rest } = values;
    const ok = await run(
      "Creating…",
      "createStaff",
      {
        ...compact(rest),
        scopes: [{ role, facilityId, branchId: branchId || null }],
      },
      "Staff account created.",
    );
    if (ok) setFormKey((key) => key + 1);
  }

  async function update(values: Record<string, FieldValue>) {
    if (!editing) return;
    const ok = await run("Saving…", "updateStaff", { userId: editing.userId, ...compact(values) }, "Staff details updated.");
    if (ok) { setEditing(null); setFormKey((key) => key + 1); }
  }

  async function changeRole(row: StaffRow, role: string) {
    await run("Changing role…", "changeStaffRole", { userId: row.userId, role }, "Role changed.");
  }

  const columns: Array<{ key: string; label: string; render: (row: StaffRow) => ReactNode }> = [
    { key: "staff", label: "Staff", render: (row) => <div><div className="font-medium">{row.name}</div><div className="font-mono text-[11px] text-muted-foreground">{row.staffNumber}</div></div> },
    { key: "email", label: "Email", render: (row) => row.email },
    {
      key: "role",
      label: "Role / scope",
      render: (row) => (
        <select
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
          value={row.role}
          aria-label={`Role for ${row.name}`}
          data-testid={`admin-staff-role-${row.userId}`}
          onChange={(event) => void changeRole(row, event.target.value)}
        >
          {["receptionist", "triage_nurse", "doctor", "lab_tech", "pharmacist", "cashier", "admin"].map((role) => (
            <option key={role} value={role}>{role}</option>
          ))}
        </select>
      ),
    },
    { key: "status", label: "Status", render: (row) => <StatusBadge active={row.isActive} /> },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <div className="flex gap-1">
          <Button type="button" size="xs" variant="outline" onClick={() => { setEditing(row); setFormKey((key) => key + 1); }}>Edit</Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!row.isActive}
            onClick={() => void run("Deactivating…", "setStaffActive", { userId: row.userId, active: false }, "Staff account deactivated.")}
          >
            Deactivate
          </Button>
          {!row.isActive ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => void run("Activating…", "setStaffActive", { userId: row.userId, active: true }, "Staff account activated.")}>
              Activate
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="Staff accounts" description="Accounts, assigned roles and facility scopes." testId="admin-staff-list">
        <DataTable rows={overview.staff} columns={columns} testId="admin-staff-rows" empty="No staff accounts for this facility." />
      </Panel>
      <Panel title={editing ? "Edit staff member" : "New staff account"} description="New accounts receive a temporary password and one role scope." testId="admin-staff-form-panel">
        <RecordForm
          key={`staff-${formKey}`}
          fields={editing ? editFields : createFields}
          initial={editing ? { name: editing.name, phone: editing.phone ?? "" } : undefined}
          submitLabel={editing ? "Update staff" : "Create account"}
          busy={busy}
          testId="admin-staff-form"
          onSubmit={(values) => void (editing ? update(values) : create(values))}
          onCancel={editing ? () => { setEditing(null); setFormKey((key) => key + 1); } : undefined}
        />
      </Panel>
      <div className="lg:col-span-2">
        <AdminAccessPanel overview={overview} busy={busy} run={run} />
      </div>
    </div>
  );
}

type CatalogKind = "items" | "labTests" | "services";

function CatalogsPanel({ overview, busy, run }: PanelProps) {
  const [kind, setKind] = useState<CatalogKind>("services");
  const [editing, setEditing] = useState<CatalogRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [icdRows, setIcdRows] = useState("A00,Cholera,Cholera\nA01,Typhoid fever,Typhoid");
  const [importBusy, setImportBusy] = useState(false);

  const config = {
    items: { create: "createItem", update: "updateItem", active: "setItemActive", label: "Item" },
    labTests: { create: "createLabTest", update: "updateLabTest", active: "setLabTestActive", label: "Laboratory test" },
    services: { create: "createService", update: "updateService", active: "setServiceActive", label: "Service" },
  }[kind];

  const fields = useMemo<Field[]>(() => {
    const common: Field[] = [
      { name: "name", label: "Name", required: !editing, full: true },
      { name: "shared", label: "", type: "checkbox", placeholder: "Shared across facilities" },
    ];
    if (!editing) common.unshift({ name: "code", label: "Code", required: true });
    else common.unshift({ name: "id", label: "Record", type: "select", options: overview.catalogs[kind].map((row) => ({ value: row.id, label: `${row.code} — ${row.name}` })), required: true, disabled: true });

    if (kind === "items") {
      common.push(
        { name: "kind", label: "Item kind", type: "select", options: ["drug", "consumable", "reagent"].map((value) => ({ value, label: value })), required: !editing },
        { name: "unit", label: "Unit" },
        { name: "strength", label: "Strength" },
        { name: "form", label: "Form" },
      );
    } else if (kind === "labTests") {
      common.push(
        { name: "sampleType", label: "Sample type", required: !editing },
        { name: "parameters", label: "Parameters (JSON array)", type: "textarea", full: true, placeholder: '[]' },
      );
    } else {
      common.push(
        { name: "kind", label: "Service kind", type: "select", options: ["consultation", "lab", "procedure", "drug"].map((value) => ({ value, label: value })), required: !editing },
        { name: "defaultPrice", label: "Default price" },
      );
    }
    return common;
  }, [editing, kind, overview.catalogs]);

  const initial = useMemo<Record<string, FieldValue>>(() => {
    const values: Record<string, FieldValue> = { shared: false, parameters: "[]" };
    if (!editing) return values;
    const row = editing as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "boolean" || typeof value === "string") values[key] = value;
    }
    values.parameters = row.parameters ? JSON.stringify(row.parameters, null, 2) : "[]";
    return values;
  }, [editing]);

  async function submit(values: Record<string, FieldValue>) {
    const input: Record<string, unknown> = compact(values);
    if (typeof input.parameters === "string") {
      try {
        input.parameters = JSON.parse(input.parameters) as unknown;
      } catch {
        toast.error("Parameters must be valid JSON.");
        return;
      }
    }
    const ok = await run("Saving…", editing ? config.update : config.create, input, `${config.label} ${editing ? "updated" : "created"}.`);
    if (ok) { setEditing(null); setFormKey((key) => key + 1); }
  }

  async function importIcd() {
    const rows = icdRows
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [code, description, chapter] = line.split(",");
        return { code: code?.trim(), description: description?.trim(), chapter: chapter?.trim() || null };
      });
    if (rows.length === 0) { toast.error("Add at least one ICD-10 row."); return; }
    setImportBusy(true);
    try {
      const result = await postCommand<{ rows: number; inserted: number; updated: number }>("importIcd10", { rows });
      toast.success(`Imported ${result.rows} ICD-10 rows (${result.inserted} new).`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not import ICD-10 rows");
    } finally {
      setImportBusy(false);
    }
  }

  const columns: Array<{ key: string; label: string; render: (row: CatalogRow) => ReactNode }> = [
    { key: "code", label: "Code", render: (row) => <span className="font-mono text-xs">{row.code}</span> },
    { key: "name", label: "Name", render: (row) => <span className="font-medium">{row.name}</span> },
    { key: "scope", label: "Scope", render: (row) => row.scope },
    { key: "status", label: "Status", render: (row) => <StatusBadge active={row.active} /> },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <div className="flex gap-1">
          <Button type="button" size="xs" variant="outline" onClick={() => { setEditing(row); setFormKey((key) => key + 1); }}>Edit</Button>
          <Button type="button" size="xs" variant="ghost" disabled={!row.active} onClick={() => void run("Updating…", config.active, { id: row.id, active: false }, `${config.label} deactivated.`)}>Deactivate</Button>
          {!row.active ? <Button type="button" size="xs" variant="ghost" onClick={() => void run("Updating…", config.active, { id: row.id, active: true }, `${config.label} activated.`)}>Activate</Button> : null}
        </div>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Catalogs" description="Shared and facility-specific items, laboratory tests and services." testId="admin-catalog-list">
          <div className="mb-4 flex gap-1" role="tablist" aria-label="Catalog type">
            {(["services", "items", "labTests"] as const).map((value) => (
              <Button key={value} type="button" role="tab" size="sm" variant={kind === value ? "default" : "outline"} aria-selected={kind === value} data-testid={`admin-catalog-tab-${value}`} onClick={() => { setKind(value); setEditing(null); setFormKey((key) => key + 1); }}>
                {value === "labTests" ? "Lab tests" : value[0].toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </div>
          <DataTable rows={overview.catalogs[kind]} columns={columns} testId={`admin-catalog-rows-${kind}`} />
        </Panel>
        <Panel title={editing ? `Edit ${config.label.toLowerCase()}` : `New ${config.label.toLowerCase()}`} description="Catalog rows can be shared or kept local to this facility." testId="admin-catalog-form-panel">
          <RecordForm
            key={`${kind}-${formKey}`}
            fields={fields}
            initial={initial}
            submitLabel={editing ? "Update" : "Create"}
            busy={busy}
            testId="admin-catalog-form"
            onSubmit={(values) => void submit(values)}
            onCancel={editing ? () => { setEditing(null); setFormKey((key) => key + 1); } : undefined}
          />
        </Panel>
      </div>
      <Panel title="ICD-10 import" description="CSV lines of code, description, chapter. Existing codes are updated." testId="admin-icd-panel">
        <div className="space-y-3">
          <Label htmlFor="admin-icd-rows">ICD-10 CSV rows</Label>
          <textarea id="admin-icd-rows" data-testid="admin-icd-rows" className="min-h-24 w-full rounded-lg border border-input bg-transparent p-2 font-mono text-xs dark:bg-input/30" value={icdRows} onChange={(event) => setIcdRows(event.target.value)} />
          <Button type="button" size="sm" disabled={importBusy} data-testid="admin-icd-import" onClick={() => void importIcd()}>{importBusy ? "Importing…" : "Import ICD-10 rows"}</Button>
        </div>
      </Panel>
    </div>
  );
}

function PriceListsPanel({ overview, busy, run }: PanelProps) {
  const [editingList, setEditingList] = useState<PriceListRow | null>(null);
  const [listKey, setListKey] = useState(0);

  const targetOptions = useMemo(() => {
    const services = overview.catalogs.services.map((service) => ({ value: service.id, label: `Service · ${service.code} — ${service.name}` }));
    const items = overview.catalogs.items.map((item) => ({ value: item.id, label: `Item · ${item.code} — ${item.name}` }));
    return [...services, ...items];
  }, [overview.catalogs.items, overview.catalogs.services]);
  const priceListOptions = useMemo(
    () => overview.priceLists.map((list) => ({ value: list.id, label: `${list.payerType} — ${list.name}` })),
    [overview.priceLists],
  );

  const listFields = useMemo<Field[]>(() => [
    { name: "name", label: "Price list name", required: !editingList },
    {
      name: "payerType",
      label: "Payer type",
      type: "select",
      required: true,
      disabled: Boolean(editingList),
      options: ["cash", "sha", "insurance"].map((value) => ({ value, label: value })),
    },
    { name: "active", label: "", type: "checkbox", placeholder: "Active" },
  ], [editingList]);

  const priceListColumns: Array<{ key: string; label: string; render: (row: PriceListRow) => ReactNode }> = [
    { key: "name", label: "Name", render: (row) => <span className="font-medium">{row.name}</span> },
    { key: "payer", label: "Payer", render: (row) => row.payerType },
    { key: "count", label: "Prices", render: (row) => row.priceCount },
    { key: "status", label: "Status", render: (row) => <StatusBadge active={row.active} /> },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <div className="flex gap-1">
          <Button type="button" size="xs" variant="outline" onClick={() => { setEditingList(row); setListKey((key) => key + 1); }}>Edit</Button>
          <Button type="button" size="xs" variant="ghost" disabled={!row.active} onClick={() => void run("Updating…", "setPriceListActive", { id: row.id, active: false }, "Price list deactivated.")}>Deactivate</Button>
          {!row.active ? <Button type="button" size="xs" variant="ghost" onClick={() => void run("Updating…", "setPriceListActive", { id: row.id, active: true }, "Price list activated.")}>Activate</Button> : null}
        </div>
      ),
    },
  ];

  const priceColumns: Array<{ key: string; label: string; render: (row: PriceRow) => ReactNode }> = [
    { key: "list", label: "List", render: (row) => row.priceListName },
    { key: "target", label: "Service / item", render: (row) => row.targetName },
    { key: "type", label: "Type", render: (row) => row.targetType },
    { key: "amount", label: "Amount", render: (row) => <span className="font-mono tabular-nums">{row.amount}</span> },
    { key: "status", label: "Status", render: (row) => <StatusBadge active={row.active} /> },
    {
      key: "actions",
      label: "Actions",
      render: (row) => row.active ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          data-testid={`admin-price-remove-${row.id}`}
          onClick={() => void run("Voiding…", "removePrice", { id: row.id }, "Price voided; the row remains in history.")}
        >
          Void price
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">Voided</span>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Price lists" description="One negotiated list per payer type." testId="admin-price-list-list">
          <DataTable rows={overview.priceLists} columns={priceListColumns} testId="admin-price-list-rows" />
        </Panel>
        <Panel title={editingList ? "Edit price list" : "New price list"} description="Cash is the fallback payer list." testId="admin-price-list-form-panel">
          <RecordForm
            key={`price-list-${listKey}`}
            fields={listFields}
            initial={editingList ? { name: editingList.name, payerType: editingList.payerType, active: editingList.active } : { active: true }}
            submitLabel={editingList ? "Update list" : "Create list"}
            busy={busy}
            testId="admin-price-list-form"
            onSubmit={(values) => void (async () => {
              const ok = await run("Saving…", editingList ? "updatePriceList" : "createPriceList", { ...compact(values), ...(editingList ? { id: editingList.id } : {}) }, `Price list ${editingList ? "updated" : "created"}.`);
              if (ok) { setEditingList(null); setListKey((key) => key + 1); }
            })()}
            onCancel={editingList ? () => { setEditingList(null); setListKey((key) => key + 1); } : undefined}
          />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Prices" description="Prices attached to a service or stock item in a list." testId="admin-price-list-detail">
          <DataTable rows={overview.prices} columns={priceColumns} testId="admin-price-rows" empty="No prices configured yet." />
        </Panel>
        <Panel title="Set a price" description="Adding an existing target updates its amount." testId="admin-price-form-panel">
          <RecordForm
            fields={[
              { name: "priceListId", label: "Price list", type: "select", options: priceListOptions, required: true },
              {
                name: "targetType",
                label: "Target type",
                type: "select",
                required: true,
                options: [{ value: "service", label: "Service" }, { value: "item", label: "Item" }],
              },
              { name: "targetId", label: "Service / item", type: "select", options: targetOptions, required: true, full: true },
              { name: "amount", label: "Amount", required: true, placeholder: "0.00" },
            ]}
            submitLabel="Save price"
            busy={busy}
            testId="admin-price-form"
            onSubmit={(values) => void run("Saving…", "upsertPrice", compact(values), "Price saved.")}
          />
        </Panel>
      </div>
    </div>
  );
}

const auditFilterFields: Field[] = [
  { name: "action", label: "Action" },
  { name: "module", label: "Module" },
  { name: "entity", label: "Entity" },
  { name: "userId", label: "User ID" },
  { name: "entityId", label: "Entity ID" },
  { name: "from", label: "From", placeholder: "2026-11-18T00:00" },
  { name: "to", label: "To", placeholder: "2026-11-19T00:00" },
  { name: "limit", label: "Limit", type: "number" },
];

function AuditPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({ limit: "100" });
  const [loading, setLoading] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async (filters: Record<string, FieldValue>) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      Object.entries(compact(filters)).forEach(([key, value]) => params.set(key, String(value)));
      const data = await requestJson<{ events: AuditEvent[] }>(`/api/admin/audit?${params.toString()}`);
      setEvents(data.events);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load audit events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load({ limit: "100" }); }, [load]);

  const columns: Array<{ key: string; label: string; render: (row: AuditEvent) => ReactNode }> = [
    { key: "when", label: "When", render: (row) => <span className="font-mono text-xs">{new Date(row.created_at).toLocaleString("en-KE")}</span> },
    { key: "action", label: "Action", render: (row) => <span className="font-medium">{row.action}</span> },
    { key: "entity", label: "Entity", render: (row) => `${row.module} · ${row.entity}` },
    { key: "entityId", label: "Entity ID", render: (row) => <span className="font-mono text-[11px]">{row.entity_id ?? "—"}</span> },
    { key: "user", label: "User", render: (row) => row.user_id ?? "—" },
    { key: "details", label: "Details", render: (row) => <code className="text-[11px]">{JSON.stringify(row.details)}</code> },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Panel title="Audit filters" description="Filter the append-only audit log for this facility." testId="admin-audit-filter-panel">
        <RecordForm
          key={formKey}
          fields={auditFilterFields}
          initial={values}
          submitLabel={loading ? "Loading…" : "Apply filters"}
          testId="admin-audit-filter"
          onSubmit={(next) => { setValues(next); void load(next); }}
          onCancel={() => { const reset = { limit: "100" }; setValues(reset); setFormKey((key) => key + 1); void load(reset); }}
        />
      </Panel>
      <Panel title="Audit events" description="Newest first, limited to the selected facility." testId="admin-audit-results">
        <DataTable rows={events} columns={columns} testId="admin-audit-rows" empty={loading ? "Loading audit events…" : "No audit events match these filters."} />
      </Panel>
    </div>
  );
}

function SyncPanel() {
  const [monitor, setMonitor] = useState<SyncMonitor | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMonitor(await requestJson<SyncMonitor>("/api/admin/sync"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load sync status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const retry = useCallback(async (outboxIds: string[], label: string) => {
    setBusyId(label);
    try {
      const result = await requestJson<{ retried: number }>("/api/admin/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          outboxIds.length === 1
            ? { action: "retry", outboxIds }
            : { action: "retry-all" },
        ),
      });
      toast.success(`${result.retried} row(s) queued for retry.`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not retry rows");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const status = monitor?.status;
  const oldestHours = status?.oldestPendingSeconds == null
    ? null
    : Math.floor(status.oldestPendingSeconds / 3600);
  const stale = oldestHours !== null && oldestHours >= 24;

  const metric = (label: string, value: string, testId: string) => (
    <div className="rounded-lg border border-border bg-muted/30 p-3" data-testid={testId}>
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );

  const columns: Array<{ key: string; label: string; render: (row: FailedSyncRow) => ReactNode }> = [
    { key: "when", label: "When", render: (row) => <span className="font-mono text-xs">{new Date(row.createdAt).toLocaleString("en-KE")}</span> },
    { key: "record", label: "Record", render: (row) => <><span className="font-medium">{row.tableName}</span><br /><code className="text-[11px]">{row.recordId}</code></> },
    { key: "operation", label: "Operation", render: (row) => row.operation },
    { key: "attempts", label: "Attempts", render: (row) => <span className="tabular-nums">{row.attempts}</span> },
    { key: "error", label: "Last error", render: (row) => <span className="text-xs text-[var(--status-critical)]">{row.lastError ?? "—"}</span> },
    { key: "payload", label: "Payload", render: (row) => <code className="block max-w-xs truncate text-[11px]">{row.payloadPreview}</code> },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busyId !== null}
          data-testid={`admin-sync-retry-${row.outboxId}`}
          onClick={() => void retry([row.outboxId], row.outboxId)}
        >
          {busyId === row.outboxId ? "Retrying…" : "Retry"}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {stale ? (
        <div
          className="rounded-lg border border-[var(--status-critical)] bg-[var(--status-critical-background)] px-4 py-3 text-sm text-[var(--status-critical-foreground)]"
          data-testid="admin-sync-stale-alert"
          role="alert"
        >
          Oldest pending row is {oldestHours} hours old. Check the clinic server connection.
        </div>
      ) : null}

      <Panel
        title="Sync health"
        description="Outbox state for the active facility. Clinic mode syncs to the configured cloud."
        testId="admin-sync-status-panel"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {metric("Mode", status?.appMode ?? "—", "admin-sync-mode-metric")}
          {metric("Pending", String(status?.pendingCount ?? 0), "admin-sync-pending-metric")}
          {metric("Failed", String(status?.failedCount ?? 0), "admin-sync-failed-metric")}
          {metric("Oldest pending", oldestHours === null ? "—" : `${oldestHours}h`, "admin-sync-oldest-metric")}
        </div>
        <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <p data-testid="admin-sync-last-success">
            Last successful push: <span className="font-mono text-foreground">{status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString("en-KE") : "never"}</span>
          </p>
          <p data-testid="admin-sync-last-pull">
            Last catalog pull: <span className="font-mono text-foreground">{status?.lastPulledAt ? new Date(status.lastPulledAt).toLocaleString("en-KE") : "never"}</span>
          </p>
          <p data-testid="admin-sync-last-error">
            Last error: <span className="font-mono text-foreground">{status?.lastError ?? "none"}</span>
          </p>
        </div>
      </Panel>

      <Panel
        title="Failed rows"
        description="Rows that exhausted retries. Retry queues them again from the first backoff step."
        testId="admin-sync-failed-panel"
      >
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={(monitor?.failedRows.length ?? 0) === 0 || busyId !== null}
            data-testid="admin-sync-retry-all"
            onClick={() => void retry([], "all")}
          >
            {busyId === "all" ? "Retrying…" : "Retry all"}
          </Button>
        </div>
        <DataTable
          rows={(monitor?.failedRows ?? []).map((row) => ({ ...row, id: row.outboxId }))}
          columns={columns}
          testId="admin-sync-failed-rows"
          empty={loading ? "Loading sync rows…" : "No failed rows."}
        />
      </Panel>
    </div>
  );
}

export function AdminWorkspace({ section }: { section: AdminSection }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await requestJson<Overview>("/api/admin/overview");
      setOverview(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load administration data");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (
    label: string,
    command: string,
    input: Record<string, unknown>,
    success: string,
  ) => {
    setBusy(label);
    try {
      await postCommand(command, input);
      await load();
      toast.success(success);
      return true;
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The request could not be completed");
      return false;
    } finally {
      setBusy(null);
    }
  }, [load]);

  async function switchFacility(facilityId: string) {
    setBusy("Switching…");
    try {
      const response = await fetch("/api/session/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facilityId, branchId: null }),
      });
      if (!response.ok) throw new Error("Could not switch facility");
      await load();
      toast.success("Active facility changed.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not switch facility");
    } finally {
      setBusy(null);
    }
  }

  if (!overview) {
    if (error) {
      return (
        <div data-testid="admin-loading">
          <ErrorPanel
            error={new Error(error)}
            reset={() => void load()}
            title="Administration data could not be loaded"
          />
        </div>
      );
    }
    return (
      <LoadingPanel
        label="Loading administration data"
        title="Loading administration data…"
        rows={4}
        data-testid="admin-loading"
      />
    );
  }

  const visibleSections = ADMIN_SECTIONS.filter((item) => overview.sections.includes(item));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Active facility</p>
          <select
            className="mt-1 h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
            aria-label="Active facility"
            data-testid="admin-active-facility"
            value={overview.facilityId}
            onChange={(event) => void switchFacility(event.target.value)}
          >
            {overview.facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>{facility.code} — {facility.name}</option>
            ))}
          </select>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">
          Configuration changes are verified, audited and replay-safe. Deactivated rows stay in place for history.
        </p>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border" aria-label="Administration sections">
        {visibleSections.map((item) => (
          <Link
            key={item}
            href={ADMIN_SECTION_META[item].href}
            role="tab"
            aria-selected={section === item}
            aria-controls="admin-section-panel"
            data-testid={`admin-tab-${item}`}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              section === item
                ? "border-[var(--primary)] text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {ADMIN_SECTION_META[item].label}
          </Link>
        ))}
      </div>

      <div id="admin-section-panel" role="tabpanel" aria-label={ADMIN_SECTION_META[section].label}>
        {section === "setup" ? <FacilitySetupPanel overview={overview} busy={busy} run={run} /> : null}
        {section === "staff" ? <StaffPanel overview={overview} busy={busy} run={run} /> : null}
        {section === "catalogs" ? <CatalogsPanel overview={overview} busy={busy} run={run} /> : null}
        {section === "prices" ? <PriceListsPanel overview={overview} busy={busy} run={run} /> : null}
        {section === "audit" ? <AuditPanel /> : null}
        {section === "sync" ? <SyncPanel /> : null}
      </div>
    </div>
  );
}
