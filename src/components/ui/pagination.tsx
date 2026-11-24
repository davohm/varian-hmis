"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ELLIPSIS = "ellipsis" as const;
type PageItem = number | typeof ELLIPSIS;

/**
 * Compact page window: always shows the first and last page, the current page
 * and one neighbour either side, with ellipses for the gaps. Keeps the control
 * stable at every page count instead of growing a button per page.
 */
export function paginationRange(current: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, totalPages, current - 1, current, current + 1]);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= totalPages - 2) {
    pages.add(totalPages - 3);
    pages.add(totalPages - 2);
    pages.add(totalPages - 1);
  }

  const sorted = [...pages]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((left, right) => left - right);

  const range: PageItem[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (page - previous > 1) range.push(ELLIPSIS);
    range.push(page);
    previous = page;
  }
  return range;
}

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  className?: string;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  disabled = false,
  className,
}: PaginationProps) {
  const safeTotal = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(1, page), safeTotal);
  const items = paginationRange(safePage, safeTotal);

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex items-center gap-2", className)}
      data-testid="pagination"
    >
      <span className="text-xs text-muted-foreground sm:hidden">
        Page {safePage} of {safeTotal}
      </span>

      <div className="hidden items-center gap-1 sm:flex">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={disabled || safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>

        {items.map((item, index) =>
          item === ELLIPSIS ? (
            <span
              key={`ellipsis-${index}`}
              aria-hidden="true"
              className="grid size-7 place-items-center text-xs text-muted-foreground"
            >
              …
            </span>
          ) : (
            <Button
              key={item}
              type="button"
              variant={item === safePage ? "default" : "ghost"}
              size="icon-sm"
              aria-label={`Page ${item}`}
              aria-current={item === safePage ? "page" : undefined}
              disabled={disabled}
              onClick={() => onPageChange(item)}
              className="tabular-nums"
            >
              {item}
            </Button>
          ),
        )}

        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={disabled || safePage >= safeTotal}
          onClick={() => onPageChange(safePage + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>

      <div className="flex items-center gap-1 sm:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || safePage >= safeTotal}
          onClick={() => onPageChange(safePage + 1)}
        >
          Next
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
