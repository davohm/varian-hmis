import { notFound } from "next/navigation";

import { AdminSectionPage } from "@/components/admin/admin-section-page";
import { isAdminSection } from "@/lib/admin-sections";

export const dynamic = "force-dynamic";

export default async function AdminSectionRoute({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  return <AdminSectionPage section={section} />;
}
