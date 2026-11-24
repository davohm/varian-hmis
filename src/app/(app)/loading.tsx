import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading workspace</span>
      <div className="border-b border-border pb-5">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="mt-4 h-8 w-56 max-w-full" />
        <Skeleton className="mt-2 h-4 w-[32rem] max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-border bg-card p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-64 max-w-full" />
          <Skeleton className="mt-5 h-10 w-full" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-4/5" />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-2 h-3 w-52 max-w-full" />
          <div className="mt-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-2 h-3 w-48 max-w-full" />
          </div>
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
        <div className="mt-4 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}
