import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUnreadPoll } from "./unread-poll";

/** A tab whose visibility the test controls. */
function createTab(hidden = false) {
  const listeners = new Set<() => void>();
  return {
    isHidden: () => hidden,
    onVisibilityChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hide() {
      hidden = true;
      listeners.forEach((listener) => listener());
    },
    show() {
      hidden = false;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("startUnreadPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the Unread count every 60 seconds, and not before", async () => {
    const counts: number[] = [];
    let unread = 2;

    startUnreadPoll({
      fetchCount: async () => unread,
      onCount: (count) => counts.push(count),
      tab: createTab(),
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(counts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(counts).toEqual([2]);

    unread = 5;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(counts).toEqual([2, 5]);
  });

  it("makes no check while the tab is hidden", async () => {
    const fetchCount = vi.fn(async () => 1);
    const tab = createTab();

    startUnreadPoll({ fetchCount, onCount: () => {}, tab });
    tab.hide();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("makes no check when it starts in a hidden tab", async () => {
    const fetchCount = vi.fn(async () => 1);

    startUnreadPoll({ fetchCount, onCount: () => {}, tab: createTab(true) });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("checks once when the tab becomes visible, then every 60 seconds from then", async () => {
    const fetchCount = vi.fn(async () => 4);
    const counts: number[] = [];
    const tab = createTab();

    startUnreadPoll({
      fetchCount,
      onCount: (count) => counts.push(count),
      tab,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    tab.hide();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    tab.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([4]);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchCount).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });

  it("ignores a failed check and keeps checking at the same interval", async () => {
    const counts: number[] = [];
    const fetchCount = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(3);

    startUnreadPoll({
      fetchCount,
      onCount: (count) => counts.push(count),
      tab: createTab(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(counts).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(counts).toEqual([3]);
  });

  it("stops checking, and drops an answer still on its way, once stopped", async () => {
    const counts: number[] = [];
    let answer: (count: number) => void = () => {};
    const fetchCount = vi.fn(
      () => new Promise<number>((resolve) => (answer = resolve))
    );
    const tab = createTab();

    const stop = startUnreadPoll({
      fetchCount,
      onCount: (count) => counts.push(count),
      tab,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCount).toHaveBeenCalledTimes(1);

    stop();
    answer(7);
    tab.show();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(counts).toEqual([]);
    expect(fetchCount).toHaveBeenCalledTimes(1);
  });
});
