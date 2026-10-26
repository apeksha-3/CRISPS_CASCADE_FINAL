// real/loeo.ts
// Leave-one-event-out folds. For each event E: the policy may learn from every OTHER event's episodes (in a fixed
// order) and is then scored on E's episodes with learning switched off. Nothing about E reaches the policy before E is scored,
// and E's episodes (for example the 3 cut from one flood) never teach each other.

export interface Fold<T> {
  event: string;
  train: T[];
  test: T[];
}

export function loeoFolds<T>(items: T[], eventOf: (x: T) => string): Fold<T>[] {
  return [...new Set(items.map(eventOf))].sort().map((event) => ({
    event,
    train: items.filter((x) => eventOf(x) !== event),
    test: items.filter((x) => eventOf(x) === event),
  }));
}
