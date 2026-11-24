import { addMonths } from './dates.js';

function tx(id, propertyId, date, price, extra = {}) {
  return { id, propertyId, date, price, ...extra };
}

function backgroundChain(prefix, startMonth, months, factor = 1.02, startPrice = 100000) {
  const out = [];
  let price = startPrice;
  for (let i = 0; i < months; i += 1) {
    if (i > 0) price = Math.round(price * factor);
    out.push(tx(`${prefix}-T${i + 1}`, prefix, `${addMonths(startMonth, i)}-15`, price));
  }
  return out;
}

export const SAMPLES = {
  handcheck: {
    meta: {
      name: '可算清的小例：基准、权重与区间',
      description: '三所独立房屋同在 2024-01 与 2024-02 成交；基准月=0，二月系数是三个对数价比的加权平均。',
    },
    transactions: [
      tx('HC1-1', 'HC1', '2024-01-10', 100000),
      tx('HC1-2', 'HC1', '2024-02-10', 108000),
      tx('HC2-1', 'HC2', '2024-01-12', 100000),
      tx('HC2-2', 'HC2', '2024-02-12', 110000),
      tx('HC3-1', 'HC3', '2024-01-18', 100000),
      tx('HC3-2', 'HC3', '2024-02-18', 112000),
      // These two make interval weighting visibly 1 and 1/2 when selected.
      tx('HW1-1', 'HW1', '2024-01-05', 100000),
      tx('HW1-2', 'HW1', '2024-02-05', 110000),
      tx('HW2-1', 'HW2', '2024-01-08', 100000),
      tx('HW2-2', 'HW2', '2024-03-08', 121000),
    ],
    renovations: [],
    structureEvents: [],
  },

  disconnected: {
    meta: {
      name: '断开的月份图',
      description: '1–3 月与 6–8 月是两个可估计连通段，4–5 月完全没有连接；不能画一条连续指数。',
    },
    transactions: [
      tx('DC-A1', 'DCA', '2024-01-10', 100000),
      tx('DC-A2', 'DCA', '2024-02-10', 105000),
      tx('DC-A3', 'DCA', '2024-03-10', 110250),
      tx('DC-B1', 'DCB', '2024-01-20', 100000),
      tx('DC-B3', 'DCB', '2024-03-20', 110250),

      tx('DC-C1', 'DCC', '2024-06-10', 200000),
      tx('DC-C2', 'DCC', '2024-07-10', 208000),
      tx('DC-C3', 'DCC', '2024-08-10', 216320),
      tx('DC-D1', 'DCD', '2024-06-20', 200000),
      tx('DC-D3', 'DCD', '2024-08-20', 216320),
    ],
    renovations: [],
    structureEvents: [],
  },

  sameDay: {
    meta: {
      name: '同日成交样本',
      description: 'SD1 在同一天留下 100→130 的两笔记录；它能核对数据但不识别任何月份涨幅。',
    },
    transactions: [
      ...backgroundChain('BG', '2024-01', 4, 1.02).map((t) => ({ ...t, id: `SD-${t.id}` })),
      tx('SD1-1', 'SD1', '2024-02-16', 100000, { seq: 1 }),
      tx('SD1-2', 'SD1', '2024-02-16', 130000, { seq: 2 }),
      tx('SD2-1', 'SD2', '2024-01-08', 120000),
      tx('SD2-2', 'SD2', '2024-03-08', 127300),
    ],
    renovations: [],
    structureEvents: [],
  },

  badMerge: {
    meta: {
      name: '错误实体合并样本',
      description: '错误链接把 H7 与 H8 当成同一实体。默认拦截跨房屋配对；可在 A/B 中演示放行后的污染。',
    },
    transactions: [
      ...backgroundChain('BM', '2024-01', 8, 1.015).map((t) => ({ ...t, id: `BM-${t.id}` })),
      tx('H7-1', 'H7', '2024-01-12', 100000),
      tx('H8-1', 'H8', '2024-08-12', 260000),
      tx('BMX-1', 'BMX', '2024-02-01', 150000),
      tx('BMX-2', 'BMX', '2024-05-01', 159200),
    ],
    renovations: [],
    structureEvents: [
      {
        id: 'BAD-ENTITY-78',
        type: 'entity_merge',
        date: '2024-09-02',
        ids: ['H7', 'H8'],
        status: 'erroneous',
        note: '税务宗地号撞号；人工核实为两处不同房屋',
      },
    ],
  },

  renovationSplit: {
    meta: {
      name: '翻修与拆分样本',
      description: 'H2 在持有期翻修；H3 的相邻两笔成交之间发生拆分，该匹配对必须断开。',
    },
    transactions: [
      ...backgroundChain('RS1', '2024-01', 6, 1.02),
      tx('RS2-1', 'RS2', '2024-01-10', 100000),
      tx('RS2-2', 'RS2', '2024-06-10', 125000),
      tx('RS3-1', 'RS3', '2024-01-12', 100000),
      tx('RS3-2', 'RS3', '2024-05-12', 120000),
      tx('RS3A-1', 'RS3A', '2024-05-20', 65000),
      tx('RS3A-2', 'RS3A', '2024-06-18', 67000),
    ],
    renovations: [
      { id: 'RENO-RS2', propertyId: 'RS2', date: '2024-03-05', cost: 15000, type: 'kitchen-and-bath' },
    ],
    structureEvents: [
      {
        id: 'SPLIT-RS3',
        type: 'split',
        date: '2024-03-18',
        from: ['RS3'],
        to: ['RS3A', 'RS3B'],
        note: '主屋与侧院拆成两个宗地',
      },
    ],
  },
};

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateBatchDataset(options = {}) {
  const propertyCount = options.properties ?? 5000;
  const monthCount = options.months ?? 84;
  const seed = options.seed ?? 2611736;
  const rand = mulberry32(seed);
  const startMonth = options.startMonth ?? '2018-01';
  const transactions = [];
  const renovations = [];
  const structureEvents = [];
  let txSeq = 0;

  for (let p = 0; p < propertyCount; p += 1) {
    const id = `B${String(p + 1).padStart(6, '0')}`;
    const basePrice = 80000 + Math.floor(rand() * 520000);
    const firstMonthIndex = Math.floor(rand() * Math.max(1, monthCount - 18));
    const saleCount = 2 + Math.floor(rand() * 3); // 2..4 sales => 1..3 adjacent pairs
    let monthCursor = firstMonthIndex;
    let lastLogNoise = (rand() - 0.5) * 0.12;

    for (let s = 0; s < saleCount; s += 1) {
      if (s > 0) monthCursor += 3 + Math.floor(rand() * 18);
      if (monthCursor >= monthCount) break;
      lastLogNoise += (rand() - 0.48) * 0.1;
      const marketLog = monthCursor * 0.0045 + Math.sin(monthCursor / 6) * 0.015;
      const price = Math.max(10000, Math.round(basePrice * Math.exp(marketLog + lastLogNoise)));
      const month = addMonths(startMonth, monthCursor);
      const day = String(1 + Math.floor(rand() * 27)).padStart(2, '0');
      transactions.push(tx(`BTX-${txSeq += 1}`, id, `${month}-${day}`, price));

      if (s === 1 && rand() < 0.16) {
        const renoMonth = addMonths(month, 1 + Math.floor(rand() * 8));
        renovations.push({
          id: `BRENO-${p + 1}`,
          propertyId: id,
          date: `${renoMonth}-${day}`,
          cost: Math.round(5000 + rand() * 45000),
          type: 'batch-renovation',
        });
      }
    }

    if (rand() < 0.012) {
      const splitMonthIndex = firstMonthIndex + 2 + Math.floor(rand() * 12);
      if (splitMonthIndex < monthCount) {
        const month = addMonths(startMonth, splitMonthIndex);
        structureEvents.push({
          id: `BSPLIT-${p + 1}`,
          type: 'split',
          date: `${month}-15`,
          from: [id],
          to: [`${id}-A`, `${id}-B`],
        });
      }
    }
  }

  return {
    meta: {
      name: `批量样本 ${propertyCount} 屋 / seed ${seed}`,
      generated: true,
      propertyCount,
      monthCount,
      seed,
    },
    transactions,
    renovations,
    structureEvents,
  };
}
