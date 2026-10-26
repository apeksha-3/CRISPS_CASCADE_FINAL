// ml/nowcast.ts
// Run an exported nowcast model in TypeScript. The models are trained offline by scripts/ml/train.py and exported as JSON;
// this file is the whole runtime: no Python, no library. It is NOT wired into the engine (Phase 9 does not do that).
//
//   climatology  the same probability for every tick
//   rule         rain intensity now >= threshold ? p_above : p_below
//   logistic     z = sum(((x - mean) / std) * coef) + intercept;  p = sigmoid(platt_a * z + platt_b)
//   gbt          raw = init + learning_rate * (sum of one leaf value per tree);  p = sigmoid(platt_a * raw + platt_b)
//                (scikit-learn compares float32 features with float64 thresholds, so Math.fround is used the same way)
// A test checks these outputs equal the Python ones on 100 rows.

export type ModelName = "climatology" | "rule" | "logistic" | "gbt";

interface Tree {
  left: number[];
  right: number[];
  feature: number[];
  threshold: number[];
  value: number[];
}

export interface NowcastFile {
  target: string;
  features: string[];
  models: {
    climatology: { p: number };
    rule: { threshold: number; p_above: number; p_below: number };
    logistic: { mean: number[]; std: number[]; coef: number[]; intercept: number; platt_a: number; platt_b: number };
    gbt: { init: number; learning_rate: number; trees: Tree[]; platt_a: number; platt_b: number };
  };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function logisticScore(m: NowcastFile["models"]["logistic"], x: number[]): number {
  let z = m.intercept;
  for (let i = 0; i < m.coef.length; i++) z += ((x[i] - m.mean[i]) / m.std[i]) * m.coef[i];
  return z;
}

export function gbtScore(m: NowcastFile["models"]["gbt"], x: number[]): number {
  let raw = m.init;
  for (const t of m.trees) {
    let node = 0;
    while (t.left[node] !== -1) node = Math.fround(x[t.feature[node]]) <= t.threshold[node] ? t.left[node] : t.right[node];
    raw += m.learning_rate * t.value[node];
  }
  return raw;
}

// P(the target event happens) for one tick, from the features in the file's order (NowcastFile.features).
export function predict(file: NowcastFile, name: ModelName, x: number[]): number {
  if (x.length !== file.features.length) throw new Error(`expected ${file.features.length} features, got ${x.length}`);
  const m = file.models;
  switch (name) {
    case "climatology":
      return m.climatology.p;
    case "rule":
      return x[0] >= m.rule.threshold ? m.rule.p_above : m.rule.p_below;
    case "logistic":
      return sigmoid(m.logistic.platt_a * logisticScore(m.logistic, x) + m.logistic.platt_b);
    case "gbt":
      return sigmoid(m.gbt.platt_a * gbtScore(m.gbt, x) + m.gbt.platt_b);
  }
}
