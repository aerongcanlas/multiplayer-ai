import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { getStored, setStored } from "../lib/storage";

const sectionKey = (id: string) => `multiplayer:section:${id}`;

/** A sidebar group with a disclosure heading; its open state is remembered per section. */
export function SidebarSection({
  id,
  title,
  count,
  action,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  // Shown beside the heading, outside the toggle button so it stays its own control.
  action?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(
    () => getStored(sectionKey(id)) !== "closed",
  );
  function toggle() {
    setOpen((current) => {
      setStored(sectionKey(id), current ? "closed" : "open");
      return !current;
    });
  }
  return (
    <section
      className={`sidebar-section ${open ? "" : "sidebar-section-closed"}`}
      aria-labelledby={`${bodyId}-heading`}
      data-section={id}
    >
      <div className="sidebar-section-heading">
        <h2 id={`${bodyId}-heading`}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <ChevronDown size={14} aria-hidden="true" />
            <span>{title}</span>
            {count !== undefined && (
              <span className="sidebar-section-count">{count}</span>
            )}
          </button>
        </h2>
        {action}
      </div>
      <div id={bodyId} className="sidebar-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
