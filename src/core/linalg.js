// Dependency-free dense linear algebra and clustered WLS.
// The matrices here are small: month dummies plus at most a few nuisance terms.

export function pivotColumns(X, relativeTolerance = 1e-10) {
  if (!Array.isArray(X) || X.length === 0) return [];
  const rows = X.length;
  const cols = X[0].length;
  const matrix = X.map((row) => row.map(Number));
  let globalMax = 1;
  for (const row of matrix) {
    for (const value of row) globalMax = Math.max(globalMax, Math.abs(value));
  }
  const tolerance = relativeTolerance * globalMax;
  const pivots = [];
  let pivotRow = 0;

  for (let col = 0; col < cols && pivotRow < rows; col += 1) {
    let selected = pivotRow;
    for (let r = pivotRow + 1; r < rows; r += 1) {
      if (Math.abs(matrix[r][col]) > Math.abs(matrix[selected][col])) selected = r;
    }
    if (Math.abs(matrix[selected][col]) <= tolerance) continue;
    [matrix[pivotRow], matrix[selected]] = [matrix[selected], matrix[pivotRow]];

    for (let r = pivotRow + 1; r < rows; r += 1) {
      const factor = matrix[r][col] / matrix[pivotRow][col];
      if (factor === 0) continue;
      matrix[r][col] = 0;
      for (let c = col + 1; c < cols; c += 1) {
        matrix[r][c] -= factor * matrix[pivotRow][c];
      }
    }
    pivots.push(col);
    pivotRow += 1;
  }
  return pivots;
}

export function invertMatrix(source) {
  const n = source.length;
  if (n === 0) return [];
  const a = source.map((row, i) => {
    const augmented = row.map(Number);
    for (let j = 0; j < n; j += 1) augmented.push(i === j ? 1 : 0);
    return augmented;
  });

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    const pivotValue = a[pivot][col];
    if (!Number.isFinite(pivotValue) || Math.abs(pivotValue) < 1e-12) {
      throw new Error('Matrix is rank deficient and cannot be inverted');
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];

    for (let c = 0; c < 2 * n; c += 1) a[col][c] /= pivotValue;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c += 1) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => row.slice(n));
}

function multiplyMatrixVector(A, v) {
  return A.map((row) => row.reduce((sum, aij, j) => sum + aij * v[j], 0));
}

function quadraticSandwich(Ainv, meat) {
  const temp = Ainv.map((row) =>
    row.map((_, i) => row.reduce((sum, aij, j) => sum + aij * meat[j][i], 0)),
  );
  const k = Ainv.length;
  const out = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      let sum = 0;
      for (let q = 0; q < k; q += 1) sum += temp[i][q] * Ainv[q][j];
      out[i][j] = sum;
    }
  }
  return out;
}

export function fitWLS(X, y, weights, clusterIds, options = {}) {
  const n = X.length;
  if (n === 0) return { ok: false, error: 'No observations' };
  const fullK = X[0].length;
  const w = weights ?? new Array(n).fill(1);

  // Repeat-sale rows are sparse (-1/+1 across two month columns, optionally
  // one renovation column). Accumulate X'WX through each row's nonzeros rather
  // than doing n*k^2 work.
  const A = Array.from({ length: fullK }, () => new Array(fullK).fill(0));
  const betaRight = new Array(fullK).fill(0);
  for (let i = 0; i < n; i += 1) {
    const wi = Number(w[i]);
    if (!Number.isFinite(wi) || wi <= 0) throw new RangeError(`Weight must be positive at row ${i}`);
    const nonzeros = [];
    for (let j = 0; j < fullK; j += 1) {
      if (X[i][j] !== 0) nonzeros.push([j, X[i][j]]);
    }
    for (const [a, xa] of nonzeros) {
      betaRight[a] += wi * xa * y[i];
      for (const [b, xb] of nonzeros) A[a][b] += wi * xa * xb;
    }
  }

  const normalPivots = pivotColumns(A);
  if (normalPivots.length < fullK) {
    const selected = normalPivots;
    const aliasedColumns = [];
    for (let j = 0; j < fullK; j += 1) if (!selected.includes(j)) aliasedColumns.push(j);
    const reducedX = X.map((row) => selected.map((j) => row[j]));
    const reduced = fitWLS(reducedX, y, w, clusterIds, options);
    const beta = new Array(fullK).fill(null);
    const se = new Array(fullK).fill(null);
    const modelSe = new Array(fullK).fill(null);
    const clusterSe = new Array(fullK).fill(null);
    selected.forEach((fullCol, reducedCol) => {
      beta[fullCol] = reduced.beta[reducedCol];
      se[fullCol] = reduced.se[reducedCol];
      modelSe[fullCol] = reduced.modelSe[reducedCol];
      clusterSe[fullCol] = reduced.clusterSe[reducedCol];
    });
    return {
      ...reduced,
      k: fullK,
      rank: selected.length,
      pivotColumns: selected,
      aliasedColumns,
      beta,
      se,
      modelSe,
      clusterSe,
    };
  }

  const pivots = Array.from({ length: fullK }, (_, i) => i);
  const aliasedColumns = [];
  const k = fullK;
  const Ainv = invertMatrix(A);
  const betaPivot = multiplyMatrixVector(Ainv, betaRight);
  const fitted = X.map((row) => row.reduce((sum, xj, j) => sum + xj * betaPivot[j], 0));
  const residuals = y.map((yi, i) => yi - fitted[i]);
  const weightedSse = residuals.reduce((sum, e, i) => sum + w[i] * e * e, 0);
  const degreesOfFreedom = n - k;
  const sigma2 = degreesOfFreedom > 0 ? weightedSse / degreesOfFreedom : null;

  const modelCovPivot = sigma2 === null ? null : Ainv.map((row) => row.map((v) => sigma2 * v));

  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const id = clusterIds?.[i] ?? `row-${i}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(i);
  }
  const G = groups.size;
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const indices of groups.values()) {
    const score = new Array(k).fill(0);
    for (const i of indices) {
      const wi = w[i] * residuals[i];
      const row = X[i];
      for (let a = 0; a < k; a += 1) {
        if (row[a] !== 0) score[a] += row[a] * wi;
      }
    }
    const scoreNonzeros = [];
    for (let a = 0; a < k; a += 1) {
      if (Math.abs(score[a]) > 1e-12) scoreNonzeros.push(a);
    }
    for (const a of scoreNonzeros) {
      for (const b of scoreNonzeros) meat[a][b] += score[a] * score[b];
    }
  }

  let correction = 1;
  if (options.smallSampleCorrection !== false && G > 1) {
    correction = (G / (G - 1)) * ((n - 1) / Math.max(1, n - k));
  }
  const clusterCovPivot = quadraticSandwich(Ainv, meat).map((row) => row.map((v) => correction * v));

  const requestedCovariance = options.covariance ?? 'cluster';
  const useCluster = requestedCovariance === 'cluster' && G > 1;
  const covPivot = useCluster ? clusterCovPivot : modelCovPivot;
  const sePivot = covPivot
    ? covPivot.map((row, i) => Math.sqrt(Math.max(0, row[i])))
    : betaPivot.map(() => null);

  const beta = new Array(fullK).fill(null);
  const se = new Array(fullK).fill(null);
  const modelSe = new Array(fullK).fill(null);
  const clusterSe = new Array(fullK).fill(null);
  pivots.forEach((fullCol, pivotIndex) => {
    beta[fullCol] = betaPivot[pivotIndex];
    se[fullCol] = sePivot[pivotIndex];
    if (modelCovPivot) modelSe[fullCol] = Math.sqrt(Math.max(0, modelCovPivot[pivotIndex][pivotIndex]));
    clusterSe[fullCol] = Math.sqrt(Math.max(0, clusterCovPivot[pivotIndex][pivotIndex]));
  });

  return {
    ok: true,
    n,
    k: fullK,
    rank: k,
    pivotColumns: pivots,
    aliasedColumns,
    beta,
    se,
    modelSe,
    clusterSe,
    covariance: useCluster ? 'cluster' : 'model',
    clusterCount: G,
    clusterReliable: G > 1,
    degreesOfFreedom,
    sigma2,
    residuals,
    fitted,
    weights: w,
    Ainv,
    clusterCovPivot,
    modelCovPivot,
  };
}

export function zForConfidence(level) {
  if (level >= 0.99) return 2.5758293035489004;
  if (level >= 0.95) return 1.959963984540054;
  if (level >= 0.9) return 1.6448536269514722;
  // Beasley-Springer-Moro approximation is unnecessary for this workbench;
  // callers normally use 0.90/0.95/0.99.
  return 1.959963984540054;
}
