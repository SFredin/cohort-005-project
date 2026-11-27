// PROTOTYPE — throwaway. Floating bar for flipping between UI variants.
import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Variant {
  key: string;
  name: string;
}

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  children,
}: {
  variants: Variant[];
  current: string;
  onChange: (key: string) => void;
  children?: React.ReactNode;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current)
  );

  function step(delta: number) {
    const next = (index + delta + variants.length) % variants.length;
    onChange(variants[next].key);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full bg-fuchsia-600 px-2 py-1.5 text-sm font-medium text-white shadow-xl ring-2 ring-white/40">
      <button
        onClick={() => step(-1)}
        className="rounded-full p-1 hover:bg-white/20"
        aria-label="Previous variant"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-52 text-center">
        {variants[index].key} ({variants[index].name})
      </span>
      <button
        onClick={() => step(1)}
        className="rounded-full p-1 hover:bg-white/20"
        aria-label="Next variant"
      >
        <ChevronRight className="size-4" />
      </button>
      {children}
    </div>
  );
}
