// PROTOTYPE — throwaway. Answers "How do Notifications appear in the app shell?"
// (https://github.com/SFredin/cohort-005-project/issues/6)
//
// Four variants of where Notifications live in the shell, switchable via
// `?variant=A|B|C|D` on any app route, plus a `?scenario=` for how many there are.
//
// Everything is fake and in memory: Notifications are built from the event
// catalog for whoever is selected in the DevUI panel, and "read" is local state
// that resets on reload. Marking read on click is a placeholder, not a decision:
// that belongs to "When is a Notification read, and how long is it kept?".
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { Popover } from "radix-ui";
import {
  Bell,
  CornerDownRight,
  MessageSquare,
  Receipt,
  UsersRound,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserRole } from "~/db/schema";
import { PrototypeSwitcher } from "~/components/prototype-switcher";

// ─── Fake data ───

type Kind =
  | "refund-opened"
  | "refund-decided"
  | "seat-claimed"
  | "question"
  | "reply";

interface Notification {
  id: number;
  kind: Kind;
  actor: string | null;
  text: string;
  to: string;
  ago: string;
  day: "Today" | "Earlier";
  read: boolean;
}

const KIND_ICON: Record<Kind, React.ReactNode> = {
  "refund-opened": <Receipt className="size-4" />,
  "refund-decided": <Receipt className="size-4" />,
  "seat-claimed": <UsersRound className="size-4" />,
  question: <MessageSquare className="size-4" />,
  reply: <CornerDownRight className="size-4" />,
};

const TS = "/courses/introduction-to-typescript";
const STUDENTS = [
  "Emma Wilson",
  "James Park",
  "Olivia Martinez",
  "Liam Thompson",
  "Sophia Davis",
  "Ava Nakamura",
  "Noah Blackwood",
  "Isla Fernandes",
];
const LESSONS = [
  "What is TypeScript?",
  "Primitive Types",
  "Arrays and Tuples",
  "Type Aliases and Interfaces",
  "Generics Basics",
  "Discriminated Unions",
];
const COURSES = [
  "Introduction to TypeScript",
  "Building REST APIs with Node.js",
  "Design Systems with Tailwind",
];
const AGO = [
  "2 min ago",
  "18 min ago",
  "1 hr ago",
  "3 hr ago",
  "Yesterday",
  "2 days ago",
  "Last week",
  "2 weeks ago",
];

type Draft = Pick<Notification, "kind" | "actor" | "text" | "to">;

function catalogFor(
  role: UserRole,
  isTeamAdmin: boolean,
  i: number
): Draft[] {
  const student = STUDENTS[i % STUDENTS.length];
  const lesson = LESSONS[i % LESSONS.length];
  const course = COURSES[i % COURSES.length];
  const lessonTo = `${TS}/lessons/${(i % 6) + 1}`;
  const out: Draft[] = [];

  if (role === UserRole.Admin) {
    out.push({
      kind: "refund-opened",
      actor: student,
      text: `Refund Request from ${student} for ${course}`,
      to: "/admin/refunds",
    });
  }
  if (role === UserRole.Instructor) {
    out.push({
      kind: "question",
      actor: student,
      text: `${student} asked a Question on ${lesson}`,
      to: lessonTo,
    });
    if (i % 2 === 0)
      out.push({
        kind: "reply",
        actor: student,
        text: `${student} replied to your Comment on ${lesson}`,
        to: lessonTo,
      });
  }
  if (role === UserRole.Student) {
    out.push({
      kind: "reply",
      actor: i % 2 ? student : "Sarah Chen",
      text: `${i % 2 ? student : "Sarah Chen"} replied to your Question on ${lesson}`,
      to: lessonTo,
    });
    if (i % 3 === 0)
      out.push({
        kind: "refund-decided",
        actor: null,
        text: `Your Refund Request for ${course} was ${i % 2 ? "declined" : "approved"}`,
        to: TS,
      });
  }
  if (isTeamAdmin) {
    out.push({
      kind: "seat-claimed",
      actor: student,
      text: `${student} claimed a Seat on ${course} (${(i % 9) + 2} of 10 claimed)`,
      to: "/team",
    });
  }
  return out;
}

const SCENARIOS = [
  { key: "few", name: "a few unread" },
  { key: "many", name: "many unread" },
  { key: "caught-up", name: "all read" },
  { key: "empty", name: "none ever" },
] as const;
type Scenario = (typeof SCENARIOS)[number]["key"];

function build(
  role: UserRole,
  isTeamAdmin: boolean,
  scenario: Scenario
): Notification[] {
  if (scenario === "empty") return [];
  const total = scenario === "many" ? 40 : 9;
  const unread = scenario === "many" ? 23 : scenario === "few" ? 3 : 0;
  const drafts: Draft[] = [];
  for (let i = 0; drafts.length < total; i++)
    drafts.push(...catalogFor(role, isTeamAdmin, i));
  return drafts.slice(0, total).map((d, n) => {
    const slot = Math.min(
      AGO.length - 1,
      Math.floor((n / total) * AGO.length)
    );
    return {
      ...d,
      id: n + 1,
      ago: AGO[slot],
      day: slot < 4 ? "Today" : "Earlier",
      read: n >= unread,
    };
  });
}

// ─── State ───

const VARIANTS = [
  { key: "A", name: "Bell + dropdown" },
  { key: "B", name: "Nav item + inbox page" },
  { key: "C", name: "Dot + side drawer" },
  { key: "D", name: "Bell peek + inbox page" },
];

interface Ctx {
  variant: string;
  items: Notification[];
  unread: number;
  open: (n: Notification) => void;
  markAllRead: () => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
}

const NotificationsContext = createContext<Ctx | null>(null);

function useProto() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("PrototypeNotificationsProvider missing");
  return ctx;
}

export function PrototypeNotificationsProvider({
  currentUser,
  isTeamAdmin,
  children,
}: {
  currentUser: { id: number; role: UserRole } | null;
  isTeamAdmin: boolean;
  children: React.ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [variant, setVariantState] = useState(() => {
    const v = searchParams.get("variant");
    return VARIANTS.some((x) => x.key === v) ? v! : "A";
  });
  const [scenario, setScenarioState] = useState<Scenario>(() => {
    const s = searchParams.get("scenario");
    return SCENARIOS.some((x) => x.key === s) ? (s as Scenario) : "few";
  });
  const [readIds, setReadIds] = useState<Set<number>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Keep the params on the URL across in-app navigation, so a reload or a
  // shared link lands on the same variant and scenario.
  useEffect(() => {
    if (
      searchParams.get("variant") !== variant ||
      searchParams.get("scenario") !== scenario
    ) {
      const next = new URLSearchParams(searchParams);
      next.set("variant", variant);
      next.set("scenario", scenario);
      setSearchParams(next, { replace: true, preventScrollReset: true });
    }
  }, [location.pathname, location.search, variant, scenario]);

  const base = useMemo(
    () =>
      currentUser ? build(currentUser.role, isTeamAdmin, scenario) : [],
    [currentUser?.id, currentUser?.role, isTeamAdmin, scenario]
  );
  useEffect(() => setReadIds(new Set()), [base]);

  const items = base.map((n) => ({ ...n, read: n.read || readIds.has(n.id) }));
  const unread = items.filter((n) => !n.read).length;

  const ctx: Ctx = {
    variant,
    items,
    unread,
    open(n) {
      setReadIds((prev) => new Set(prev).add(n.id));
      setDrawerOpen(false);
      navigate(n.to);
    },
    markAllRead() {
      setReadIds(new Set(base.map((n) => n.id)));
    },
    drawerOpen,
    setDrawerOpen,
  };

  return (
    <NotificationsContext.Provider value={ctx}>
      {children}
      {variant === "C" && <Drawer />}
      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        onChange={(v) => {
          setVariantState(v);
          setDrawerOpen(false);
        }}
      >
        <button
          onClick={() => {
            const i = SCENARIOS.findIndex((s) => s.key === scenario);
            setScenarioState(SCENARIOS[(i + 1) % SCENARIOS.length].key);
          }}
          className="rounded-full bg-white/20 px-3 py-1 text-xs hover:bg-white/30"
          title="Cycle how many Notifications there are"
        >
          {SCENARIOS.find((s) => s.key === scenario)!.name} · {unread} unread
          of {items.length}
        </button>
      </PrototypeSwitcher>
    </NotificationsContext.Provider>
  );
}

// ─── Shared pieces ───

function Row({ n, dense = false }: { n: Notification; dense?: boolean }) {
  const { open } = useProto();
  return (
    <button
      onClick={() => open(n)}
      className={cn(
        "flex w-full items-start gap-3 text-left transition-colors hover:bg-accent",
        dense ? "px-3 py-2.5" : "px-4 py-3.5"
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          n.read
            ? "bg-muted text-muted-foreground"
            : "bg-primary/10 text-primary"
        )}
      >
        {KIND_ICON[n.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm",
            n.read ? "text-muted-foreground" : "font-medium text-foreground"
          )}
        >
          {n.text}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {n.ago}
        </span>
      </span>
      {!n.read && (
        <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" />
      )}
    </button>
  );
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white",
        className
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function Empty({ caughtUp }: { caughtUp: boolean }) {
  return (
    <div className="px-6 py-10 text-center text-sm text-muted-foreground">
      <Bell className="mx-auto mb-2 size-5 opacity-50" />
      {caughtUp ? "You're all caught up." : "Nothing here yet."}
    </div>
  );
}

const navRow = (isActive: boolean) =>
  cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
  );

// ─── Sidebar slots: the Sidebar renders all three, each variant fills one ───

/** Top of the sidebar, right of the "Cadence" wordmark. Variants A and D. */
export function HeaderSlot() {
  const { variant, items, unread, markAllRead } = useProto();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  if (variant !== "A" && variant !== "D") return null;

  // A: the dropdown IS the inbox — everything, scrollable.
  // D: the dropdown is a peek — unread only, capped, with a way through to the page.
  const list =
    variant === "A" ? items : items.filter((n) => !n.read).slice(0, 5);
  const hiddenUnread = variant === "D" ? unread - list.length : 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="relative ml-auto rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          aria-label={`Notifications, ${unread} unread`}
        >
          <Bell className="size-4" />
          <CountBadge count={unread} className="absolute -right-1 -top-1" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          className="z-50 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">
              {variant === "A" ? "Notifications" : "Unread"}
            </span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-primary hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-[26rem] divide-y overflow-y-auto">
            {list.length === 0 ? (
              <Empty caughtUp={items.length > 0} />
            ) : (
              list.map((n) => <Row key={n.id} n={n} dense />)
            )}
          </div>
          {variant === "D" && (
            <NavLink
              to="/notifications"
              className="block border-t px-3 py-2 text-center text-xs font-medium text-primary hover:bg-accent"
            >
              {hiddenUnread > 0
                ? `${hiddenUnread} more unread · See all Notifications`
                : "See all Notifications"}
            </NavLink>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** First row of the sidebar nav. Variant B. */
export function NavSlot() {
  const { variant, unread } = useProto();
  if (variant !== "B") return null;
  return (
    <NavLink to="/notifications" className={({ isActive }) => navRow(isActive)}>
      <Bell className="size-4" />
      Notifications
      {unread > 0 && (
        <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground">
          {unread}
        </span>
      )}
    </NavLink>
  );
}

/** Bottom of the sidebar, above the user block. Variant C. */
export function FooterSlot() {
  const { variant, unread, setDrawerOpen } = useProto();
  if (variant !== "C") return null;
  return (
    <button
      onClick={() => setDrawerOpen(true)}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <span className="relative">
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 ring-2 ring-sidebar" />
        )}
      </span>
      Notifications
    </button>
  );
}

// ─── Variant C: drawer over the page, no count anywhere, unread/all filter ───

function Drawer() {
  const { items, unread, markAllRead, drawerOpen, setDrawerOpen } = useProto();
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  if (!drawerOpen) return null;
  const list = filter === "unread" ? items.filter((n) => !n.read) : items;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={() => setDrawerOpen(false)}
      />
      <aside className="fixed inset-y-0 left-56 z-50 flex w-96 flex-col border-r bg-background shadow-2xl">
        <div className="flex h-14 items-center justify-between border-b px-4">
          <span className="font-semibold">Notifications</span>
          <button
            onClick={() => setDrawerOpen(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-1 border-b px-3 py-2">
          {(["unread", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium capitalize",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              {f}
            </button>
          ))}
          {unread > 0 && (
            <button
              onClick={markAllRead}
              className="ml-auto text-xs text-primary hover:underline"
            >
              Mark all as read
            </button>
          )}
        </div>
        <div className="flex-1 divide-y overflow-y-auto">
          {list.length === 0 ? (
            <Empty caughtUp={items.length > 0} />
          ) : (
            list.map((n) => <Row key={n.id} n={n} />)
          )}
        </div>
      </aside>
    </>
  );
}

// ─── Variants B and D: the inbox page ───

export function InboxPage() {
  const { variant, items, unread, markAllRead } = useProto();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const list = filter === "unread" ? items.filter((n) => !n.read) : items;
  const days = ["Today", "Earlier"] as const;

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      {variant !== "B" && variant !== "D" && (
        <p className="mb-4 rounded-md bg-fuchsia-100 px-3 py-2 text-xs text-fuchsia-900">
          Prototype note: variant {variant} has no inbox page. Nothing links
          here; switch to B or D.
        </p>
      )}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {unread > 0 ? `${unread} unread` : "You're all caught up."}
          </p>
        </div>
        {unread > 0 && (
          <button
            onClick={markAllRead}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Mark all as read
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-1 border-b">
        {(["all", "unread"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize",
              filter === f
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="rounded-lg border">
          <Empty caughtUp={items.length > 0} />
        </div>
      ) : (
        days.map((day) => {
          const group = list.filter((n) => n.day === day);
          if (group.length === 0) return null;
          return (
            <section key={day} className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {day}
              </h2>
              <div className="divide-y overflow-hidden rounded-lg border bg-card">
                {group.map((n) => (
                  <Row key={n.id} n={n} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
