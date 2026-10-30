// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { useEffect, useRef } from "react";

type BreadcrumbsProps = {
  bucket: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
};

export const Breadcrumbs = ({ bucket, prefix, onNavigate }: BreadcrumbsProps) => {
  const parts = prefix.split("/").filter(Boolean);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [prefix]);

  return (
    <nav className="breadcrumbs" aria-label="文件路径" ref={ref}>
      <button
        type="button"
        onClick={() => onNavigate("")}
        aria-current={parts.length ? undefined : "page"}
      >
        {bucket}
      </button>
      {parts.map((part, index) => {
        const nextPrefix = `${parts.slice(0, index + 1).join("/")}/`;
        return (
          <span key={nextPrefix}>
            <span className="separator">/</span>
            <button
              type="button"
              onClick={() => onNavigate(nextPrefix)}
              aria-current={index === parts.length - 1 ? "page" : undefined}
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
};
