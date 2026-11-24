import {
  compareISODate,
  daysBetween,
  isValidDateString,
  monthDistance,
  monthKeyFromDate,
} from './dates.js';

const INVALID_STATUS = new Set(['void', 'cancelled', 'canceled', 'invalid', 'deleted', 'error']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function idList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return [String(value)];
}

export function normalizeDataset(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ path: '$', message: '顶层数据必须是对象，包含 transactions 等数组' }],
      warnings,
      data: null,
    };
  }

  const rawTransactions = asArray(raw.transactions ?? raw.sales ?? raw.deals);
  const transactions = rawTransactions.map((t, i) => {
    const path = `transactions[${i}]`;
    const tx = {
      sourceIndex: i,
      id: t?.id != null ? String(t.id) : `TX-${i + 1}`,
      propertyId: t?.propertyId != null ? String(t.propertyId) : t?.houseId != null ? String(t.houseId) : null,
      date: t?.date ?? t?.saleDate ?? null,
      price: t?.price ?? t?.amount ?? t?.salePrice ?? null,
      seq: Number.isFinite(Number(t?.seq)) ? Number(t.seq) : null,
      status: t?.status ? String(t.status).toLowerCase() : 'valid',
      note: t?.note ? String(t.note) : '',
      raw: t,
      valid: true,
      errors: [],
    };
    if (!tx.propertyId) {
      tx.valid = false;
      tx.errors.push(`${path}: 缺少 propertyId/houseId`);
    }
    if (!isValidDateString(tx.date)) {
      tx.valid = false;
      tx.errors.push(`${path}.date: 不是 YYYY-MM-DD 有效日期`);
    }
    const price = Number(tx.price);
    if (!Number.isFinite(price) || price <= 0) {
      tx.valid = false;
      tx.errors.push(`${path}.price/amount: 必须是正数`);
    } else {
      tx.price = price;
    }
    if (INVALID_STATUS.has(tx.status)) {
      tx.valid = false;
      tx.errors.push(`${path}.status: ${tx.status} 不作为有效成交`);
    }
    for (const message of tx.errors) errors.push({ path, message });
    return tx;
  });

  const rawRenovations = asArray(raw.renovations ?? raw.renovationRecords ?? raw.improvements);
  const renovations = rawRenovations.map((r, i) => {
    const path = `renovations[${i}]`;
    const item = {
      sourceIndex: i,
      id: r?.id != null ? String(r.id) : `RENO-${i + 1}`,
      propertyId: r?.propertyId != null ? String(r.propertyId) : r?.houseId != null ? String(r.houseId) : null,
      date: r?.date ?? r?.completionDate ?? null,
      cost: r?.cost ?? r?.amount ?? r?.spend ?? null,
      type: r?.type ? String(r.type) : 'renovation',
      status: r?.status ? String(r.status).toLowerCase() : 'confirmed',
      valid: true,
      errors: [],
    };
    if (!item.propertyId) {
      item.valid = false;
      item.errors.push(`${path}: 缺少 propertyId`);
    }
    if (!isValidDateString(item.date)) {
      item.valid = false;
      item.errors.push(`${path}.date: 不是有效日期`);
    }
    if (item.cost != null && item.cost !== '') {
      const cost = Number(item.cost);
      if (!Number.isFinite(cost) || cost < 0) {
        item.valid = false;
        item.errors.push(`${path}.cost: 必须是非负数`);
      } else {
        item.cost = cost;
      }
    } else {
      item.cost = 0;
      item.costMissing = true;
    }
    if (['cancelled', 'canceled', 'void'].includes(item.status)) item.valid = false;
    for (const message of item.errors) errors.push({ path, message });
    return item;
  });

  const rawEvents = asArray(
    raw.structureEvents ?? raw.splitMergeRecords ?? raw.splitMerge ?? raw.events ?? raw.merges,
  );
  const structureEvents = rawEvents.map((e, i) => {
    const path = `structureEvents[${i}]`;
    const type = String(e?.type ?? e?.kind ?? 'event').toLowerCase();
    const status = e?.status ? String(e.status).toLowerCase() : null;
    const erroneous = e?.erroneous === true || status === 'erroneous' || status === 'wrong' || /erroneous|wrong|invalid_merge/.test(type);
    const from = [
      ...idList(e?.from),
      ...idList(e?.before),
      ...idList(e?.parentIds),
      ...(type.includes('split') ? idList(e?.propertyId ?? e?.propertyID) : []),
    ];
    const to = [...idList(e?.to), ...idList(e?.after), ...idList(e?.childIds), ...idList(e?.mergedId)];
    const entityIds = [...idList(e?.ids), ...idList(e?.propertyIds), ...idList(e?.entities)];
    const event = {
      sourceIndex: i,
      id: e?.id != null ? String(e.id) : `EVT-${i + 1}`,
      type,
      date: e?.date ?? e?.effectiveDate ?? null,
      from: [...new Set(from)],
      to: [...new Set(to)],
      entityIds: [...new Set(entityIds)],
      validDate: isValidDateString(e?.date ?? e?.effectiveDate),
      valid: e?.valid !== false && status !== 'invalid' && !erroneous,
      erroneous,
      physical: e?.physical !== false && /split|merge|demolish|rebuild|subdivid/.test(type) && !/entity|identity/.test(type),
      note: e?.note ? String(e.note) : e?.reason ? String(e.reason) : '',
    };
    if (!event.validDate) {
      errors.push({ path, message: `${path}.date: 不是有效日期` });
    }
    return event;
  });

  if (transactions.filter((t) => t.valid).length < 2) {
    errors.push({ path: 'transactions', message: '至少需要两条有效成交才能构造重复成交配对' });
  }

  const txPropertyIds = new Set(transactions.map((t) => t.propertyId).filter(Boolean));
  for (const r of renovations) {
    if (r.propertyId && !txPropertyIds.has(r.propertyId)) {
      warnings.push({ code: 'orphan_renovation', message: `翻修 ${r.id} 指向未知房屋 ${r.propertyId}` });
    }
  }
  for (const e of structureEvents) {
    for (const id of [...e.from, ...e.to, ...e.entityIds]) {
      if (!txPropertyIds.has(id)) {
        warnings.push({ code: 'orphan_event_entity', message: `拆分合并记录 ${e.id} 指向数据中未出现的标识 ${id}` });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    data: {
      ...raw,
      transactions,
      renovations,
      structureEvents,
      meta: raw.meta ?? {},
    },
  };
}

function eventInvolves(event, propertyId) {
  return event.from.includes(propertyId) || event.to.includes(propertyId) || event.entityIds.includes(propertyId);
}

function sortTransactions(list) {
  return [...list].sort((a, b) => {
    const byDate = compareISODate(a.date, b.date);
    if (byDate !== 0) return byDate;
    if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
    if (a.seq != null && b.seq == null) return -1;
    if (b.seq != null && a.seq == null) return 1;
    return a.sourceIndex - b.sourceIndex;
  });
}

function makePair({ id, propertyId, first, second, source = 'adjacent', identityLinkId = null, crossEntity = false }) {
  const days = daysBetween(first.date, second.date);
  const monthFrom = monthKeyFromDate(first.date);
  const monthTo = monthKeyFromDate(second.date);
  const sameDay = first.date === second.date;
  const sameMonth = monthFrom === monthTo;
  const priceRatio = second.price / first.price;
  return {
    id,
    propertyId,
    clusterId: propertyId,
    source,
    identityLinkId,
    crossEntity,
    firstTransactionId: first.id,
    secondTransactionId: second.id,
    firstDate: first.date,
    secondDate: second.date,
    firstPrice: first.price,
    secondPrice: second.price,
    firstSeq: first.seq,
    secondSeq: second.seq,
    days,
    monthFrom,
    monthTo,
    monthSpan: sameMonth ? 0 : monthDistance(monthFrom, monthTo),
    sameDay,
    sameMonth,
    priceRatio,
    logRatio: Math.log(priceRatio),
    renovationIds: [],
    renovationCost: 0,
    renovationMeasure: 0,
    barrierEventIds: [],
    baseExclusionReasons: [],
    policyExclusionReason: null,
    used: false,
    outlier: false,
    downweighted: false,
  };
}

export function buildPairCandidates(data, options = {}) {
  const validTx = data.transactions.filter((t) => t.valid);
  const byProperty = new Map();
  for (const tx of validTx) {
    if (!byProperty.has(tx.propertyId)) byProperty.set(tx.propertyId, []);
    byProperty.get(tx.propertyId).push(tx);
  }

  const pairs = [];
  const renovationsByProperty = new Map();
  for (const renovation of data.renovations ?? []) {
    if (!renovation.propertyId) continue;
    if (!renovationsByProperty.has(renovation.propertyId)) renovationsByProperty.set(renovation.propertyId, []);
    renovationsByProperty.get(renovation.propertyId).push(renovation);
  }
  const eventsByProperty = new Map();
  for (const event of data.structureEvents ?? []) {
    const ids = new Set([...event.from, ...event.to, ...event.entityIds]);
    for (const id of ids) {
      if (!eventsByProperty.has(id)) eventsByProperty.set(id, []);
      eventsByProperty.get(id).push(event);
    }
  }

  for (const [propertyId, list] of byProperty) {
    const sorted = sortTransactions(list);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      pairs.push(makePair({ id: `${propertyId}#P${i + 1}`, propertyId, first: sorted[i], second: sorted[i + 1] }));
    }
  }

  // Erroneous identity/entity merges are not ordinary physical split/merge
  // events. Build the tempting cross-source pair separately so the UI can show
  // exactly which observation the bad rule would have consumed.
  const seenCross = new Set();
  for (const event of data.structureEvents ?? []) {
    if (!event.erroneous || !/merge|entity|identity/.test(event.type)) continue;
    const linkedIds = [...new Set([...event.entityIds, ...event.from, ...event.to])];
    const combined = sortTransactions(linkedIds.flatMap((id) => byProperty.get(id) ?? []));
    for (let i = 0; i < combined.length - 1; i += 1) {
      const a = combined[i];
      const b = combined[i + 1];
      if (a.propertyId === b.propertyId) continue;
      const key = `${event.id}:${a.id}:${b.id}`;
      if (seenCross.has(key)) continue;
      seenCross.add(key);
      const propertyId = `${a.propertyId}≠${b.propertyId}`;
      pairs.push(
        makePair({
          id: `BAD-LINK-${event.id}-${a.id}-${b.id}`,
          propertyId,
          first: a,
          second: b,
          source: 'erroneous-merge-demo',
          identityLinkId: event.id,
          crossEntity: true,
        }),
      );
      const pair = pairs[pairs.length - 1];
      pair.clusterId = event.mergedEntityId ?? event.id;
      pair.baseExclusionReasons.push('erroneous_entity_merge');
    }
  }

  // Attach renovations and physical structure barriers to same-entity pairs.
  for (const pair of pairs) {
    if (pair.crossEntity) {
      if (options.blockErroneousMerges === false) {
        pair.baseExclusionReasons = pair.baseExclusionReasons.filter((r) => r !== 'erroneous_entity_merge');
        pair.warning = '正在演示已标记错误的实体合并；该跨实体配对不可用于正式指数';
      }
      continue;
    }

    const renovations = (renovationsByProperty.get(pair.propertyId) ?? []).filter(
      (r) =>
        r.valid &&
        isValidDateString(r.date) &&
        compareISODate(r.date, pair.firstDate) >= 0 &&
        compareISODate(r.date, pair.secondDate) <= 0,
    );
    pair.renovationIds = renovations.map((r) => r.id);
    pair.renovationCost = renovations.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
    pair.renovationCostMissing = renovations.some((r) => r.costMissing);
    pair.renovationMeasure = pair.renovationCost > 0 ? pair.renovationCost / pair.firstPrice : renovations.length ? 1 : 0;

    const barriers = (eventsByProperty.get(pair.propertyId) ?? []).filter(
      (e) =>
        e.validDate &&
        e.physical &&
        compareISODate(e.date, pair.firstDate) >= 0 &&
        compareISODate(e.date, pair.secondDate) <= 0,
    );
    pair.barrierEventIds = barriers.map((e) => e.id);
    if (barriers.length) pair.baseExclusionReasons.push('structure_barrier');
    if (pair.sameDay) pair.baseExclusionReasons.push('same_day');
    else if (pair.sameMonth) pair.baseExclusionReasons.push('same_month');
  }

  return pairs;
}
