// Undirected month graph / connected components. An edge is one usable
// repeat-sale pair. Each component has one unidentified log-price level.

export function buildMonthComponents(monthCount, edges) {
  const parent = Array.from({ length: monthCount }, (_, i) => i);

  function find(x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (parent[cur] !== cur) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (const edge of edges) {
    if (Number.isInteger(edge.from) && Number.isInteger(edge.to) && edge.from !== edge.to) {
      union(edge.from, edge.to);
    }
  }

  const groups = new Map();
  for (let month = 0; month < monthCount; month += 1) {
    const root = find(month);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(month);
  }

  const components = [...groups.values()]
    .map((months, i) => {
      const sorted = months.sort((a, b) => a - b);
      const edgeCount = edges.filter((e) => {
        const root = find(e.from);
        return sorted.includes(e.from) && find(e.to) === root && e.from !== e.to;
      }).length;
      return {
        id: `C${i + 1}`,
        index: i,
        months: sorted,
        anchorMonth: sorted[0],
        edgeCount,
        estimable: sorted.length >= 2 && edgeCount >= sorted.length - 1,
      };
    })
    .sort((a, b) => a.months[0] - b.months[0])
    .map((c, i) => ({ ...c, id: `C${i + 1}` }));

  const rank = components.reduce((sum, c) => sum + Math.max(0, c.months.length - 1), 0);
  return {
    components,
    rank,
    nullity: monthCount - rank,
    isConnected: components.filter((c) => c.estimable).length <= 1 && components.every((c) => c.months.length === 1 || c.estimable),
  };
}
