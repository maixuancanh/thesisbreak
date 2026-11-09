"use client";

import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";

export function PagedList<T>({
  items,
  label,
  children,
  className,
  size = 6,
}: {
  items: readonly T[];
  label: string;
  children: (item: T, index: number) => ReactNode;
  className?: string;
  size?: number;
}) {
  const [requestedPage, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(requestedPage, pages);
  const offset = (page - 1) * size;
  if (!items.length) return null;

  return (
    <div className="workspace-paged">
      <div className={className}>
        {items
          .slice(offset, offset + size)
          .map((item, i) => children(item, offset + i))}
      </div>
      {pages > 1 && (
        <nav className="memory-pagination" aria-label={label}>
          <span aria-live="polite">
            {offset + 1}-{Math.min(offset + size, items.length)} of{" "}
            {items.length}
          </span>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} of {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page === pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
