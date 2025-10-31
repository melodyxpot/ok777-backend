// Prisma compatibility adapter using Supabase client and pg for raw.
// This is a best-effort shim to keep existing calls working while migrating off Prisma.
import { supabase } from './supabase';
import { query as pgQuery } from './pool';

type Where = Record<string, any>;

const modelToTable: Record<string, string> = {
  user: 'Users',
  balance: 'Balances',
  wallet: 'Wallets',
  deposit: 'Deposits',
  transaction: 'Transactions',
  bet: 'Bets',
  log: 'Logs',
  hashGameConfig: 'HashGameConfigs',
  gameSettings: 'GameSettings',
  payout: 'Payouts',
  game: 'Games',
  tempGame: 'TempGames',
  withdrawRequest: 'WithdrawRequests',
  product: 'Product',
  emailVerificationCode: 'EmailVerificationCodes',
  referralBonus: 'ReferralBonuses',
  referralConfig: 'ReferralConfigs',
};

function applyWhere(q: any, where?: Where) {
  if (!where) return q;
  // Handle OR compound
  if (Array.isArray(where.OR)) {
    const parts: string[] = [];
    for (const cond of where.OR) {
      for (const key of Object.keys(cond)) {
        const val = cond[key];
        if (typeof val === 'object' && val && 'contains' in val) {
          const txt = `%${val.contains}%`;
          parts.push(`${key}.ilike.${txt}`);
        } else if (typeof val === 'object' && val && 'equals' in val) {
          const eqVal = val.equals instanceof Date ? val.equals.toISOString() : val.equals;
          parts.push(`${key}.eq.${eqVal}`);
        } else if (typeof val === 'object' && val && ('gte' in val || 'lte' in val || 'gt' in val || 'lt' in val)) {
          const gte = 'gte' in val ? (val.gte instanceof Date ? val.gte.toISOString() : val.gte) : undefined;
          const lte = 'lte' in val ? (val.lte instanceof Date ? val.lte.toISOString() : val.lte) : undefined;
          const gt = 'gt' in val ? (val.gt instanceof Date ? val.gt.toISOString() : val.gt) : undefined;
          const lt = 'lt' in val ? (val.lt instanceof Date ? val.lt.toISOString() : val.lt) : undefined;
          if (gte !== undefined) parts.push(`${key}.gte.${gte}`);
          if (lte !== undefined) parts.push(`${key}.lte.${lte}`);
          if (gt !== undefined) parts.push(`${key}.gt.${gt}`);
          if (lt !== undefined) parts.push(`${key}.lt.${lt}`);
        } else {
          const prim = val instanceof Date ? val.toISOString() : val;
          parts.push(`${key}.eq.${prim}`);
        }
      }
    }
    if (parts.length) q = q.or(parts.join(','));
  }
  for (const key of Object.keys(where)) {
    if (key === 'OR') continue;
    const val = where[key];
    if (val && typeof val === 'object' && 'in' in val) {
      const arr = Array.isArray(val.in) ? val.in.map((v: any) => v instanceof Date ? v.toISOString() : v) : val.in;
      q = q.in(key, arr);
    } else if (val && typeof val === 'object' && ('gte' in val || 'lte' in val || 'gt' in val || 'lt' in val || 'equals' in val)) {
      const eqVal = 'equals' in val ? (val.equals instanceof Date ? val.equals.toISOString() : val.equals) : undefined;
      const gteVal = 'gte' in val ? (val.gte instanceof Date ? val.gte.toISOString() : val.gte) : undefined;
      const lteVal = 'lte' in val ? (val.lte instanceof Date ? val.lte.toISOString() : val.lte) : undefined;
      const gtVal = 'gt' in val ? (val.gt instanceof Date ? val.gt.toISOString() : val.gt) : undefined;
      const ltVal = 'lt' in val ? (val.lt instanceof Date ? val.lt.toISOString() : val.lt) : undefined;
      if (eqVal !== undefined) q = q.eq(key, eqVal);
      if (gteVal !== undefined) q = q.gte(key, gteVal);
      if (lteVal !== undefined) q = q.lte(key, lteVal);
      if (gtVal !== undefined) q = q.gt(key, gtVal);
      if (ltVal !== undefined) q = q.lt(key, ltVal);
    } else if (key.includes('_')) {
      // Composite unique like userId_currency
      const obj = where[key];
      if (obj && typeof obj === 'object') {
        for (const subKey of Object.keys(obj)) {
          const subVal = obj[subKey] instanceof Date ? obj[subKey].toISOString() : obj[subKey];
          q = q.eq(subKey, subVal);
        }
      }
    } else if (val && typeof val === 'object' && 'contains' in val) {
      const txt = `%${val.contains}%`;
      q = q.ilike(key, txt);
    } else {
      const prim = val instanceof Date ? val.toISOString() : val;
      q = q.eq(key, prim);
    }
  }
  return q;
}

function applyOrderSkipTake(q: any, orderBy?: any, skip?: number, take?: number) {
  if (orderBy && typeof orderBy === 'object') {
    const col = Object.keys(orderBy)[0];
    const dir = orderBy[col] === 'desc' ? { ascending: false } : { ascending: true };
    q = q.order(col, dir);
  }
  if (typeof skip === 'number' || typeof take === 'number') {
    const from = skip || 0;
    const to = (skip || 0) + (take ? take - 1 : 999999);
    q = q.range(from, to);
  }
  if (Array.isArray(orderBy)) {
    for (const ob of orderBy) {
      const k = Object.keys(ob)[0];
      const dir = ob[k] === 'desc' ? { ascending: false } : { ascending: true };
      q = q.order(k, dir);
    }
  }
  return q;
}

// Map camelCase fields used in code to actual DB columns for specific models
function remapKeyForModel(model: string, key: string): string {
  if (model === 'emailVerificationCode') {
    if (key === 'expiresAt') return 'expires_at';
    if (key === 'createdAt') return 'created_at';
  }
  if (model === 'referralBonus') {
    if (key === 'userId') return 'userId';
    if (key === 'fromUserId') return 'fromUserId';
    if (key === 'triggerType') return 'triggerType';
    if (key === 'expiresAt') return 'expiresAt';
    if (key === 'createdAt') return 'createdAt';
    if (key === 'updatedAt') return 'updatedAt';
  }
  if (model === 'referralConfig') {
    if (key === 'depositBonusPercent') return 'depositBonusPercent';
    if (key === 'betBonusPercent') return 'betBonusPercent';
    if (key === 'firstDepositBonus') return 'firstDepositBonus';
    if (key === 'firstBetBonus') return 'firstBetBonus';
    if (key === 'signupBonus') return 'signupBonus';
    if (key === 'maxBonusPerUser') return 'maxBonusPerUser';
    if (key === 'bonusExpiryDays') return 'bonusExpiryDays';
    if (key === 'updatedAt') return 'updatedAt';
  }
  return key;
}

function remapObjectKeysForModel(model: string, obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const output: any = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const newKey = remapKeyForModel(model, k);
    if (v instanceof Date) {
      output[newKey] = v.toISOString();
    } else {
      output[newKey] = v;
    }
  }
  return output;
}

function remapWhereForModel(model: string, where?: any): any {
  if (!where || typeof where !== 'object') return where;
  const out: any = {};
  for (const k of Object.keys(where)) {
    if (k === 'OR' && Array.isArray(where[k])) {
      out.OR = where[k].map((cond: any) => remapWhereForModel(model, cond));
      continue;
    }
    const newKey = remapKeyForModel(model, k);
    const val = where[k];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[newKey] = { ...val };
    } else {
      out[newKey] = val;
    }
  }
  return out;
}

function tableApi(model: string) {
  const table = modelToTable[model];
  return {
    async findMany(args: any = {}) {
      let q = supabase.from(table).select(args.select ? Object.keys(args.select).join(',') : '*');
      const remappedWhere = remapWhereForModel(model, args.where);
      q = applyWhere(q, remappedWhere);
      q = applyOrderSkipTake(q, args.orderBy, args.skip, args.take);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
    async findFirst(args: any = {}) { const rows = await this.findMany({ ...args, take: 1 }); return rows[0] || null; },
    async findUnique(args: any = {}) {
      const rows = await this.findMany({ where: args.where, take: 1 });
      return rows[0] || null;
    },
    async count(args: any = {}) {
      let q = supabase.from(table).select('*', { count: 'exact', head: true });
      const remappedWhere = remapWhereForModel(model, args.where);
      q = applyWhere(q, remappedWhere);
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    },
    async aggregate(args: any = {}) {
      // Minimal: only _sum supported with single column
      if (args._sum) {
        const col = Object.keys(args._sum)[0];
        let q = supabase.from(table).select(`${col}`);
        q = applyWhere(q, args.where);
        const { data, error } = await q;
        if (error) throw error;
        const sum = (data || []).reduce((acc: number, r: any) => acc + Number(r[col] || 0), 0);
        return { _sum: { [col]: sum } } as any;
      }
      return {} as any;
    },
    async create(args: any) {
      const dataToInsert = remapObjectKeysForModel(model, args.data);
      const { data, error } = await supabase.from(table).insert(dataToInsert).select('*').single();
      if (error) throw error;
      return data;
    },
    async createMany(args: any) {
      const dataToInsert = Array.isArray(args.data)
        ? args.data.map((d: any) => remapObjectKeysForModel(model, d))
        : remapObjectKeysForModel(model, args.data);
      const { error } = await supabase.from(table).insert(dataToInsert);
      if (error) throw error;
      return { count: (args.data || []).length } as any;
    },
    async update(args: any) {
      let q = supabase.from(table).update(args.data);
      const remappedWhere = remapWhereForModel(model, args.where);
      q = applyWhere(q, remappedWhere);
      const { data, error } = await q.select('*').single();
      if (error) throw error;
      return data;
    },
    async updateMany(args: any) {
      try {
        let q = supabase.from(table).update(args.data);
        const remappedWhere = remapWhereForModel(model, args.where);
        q = applyWhere(q, remappedWhere);
        const { data, error } = await q.select('*');
        if (error) throw error;
        return { count: data ? data.length : 0 };
      } catch (error) {
        console.error(`Error in updateMany for ${model}:`, error);
        throw error;
      }
    },
    async delete(args: any) {
      let q = supabase.from(table).delete();
      const remappedWhere = remapWhereForModel(model, args.where);
      q = applyWhere(q, remappedWhere);
      const { data, error } = await q.select('*').single();
      if (error) throw error;
      return data;
    },
    async upsert(args: any) {
      const existing = await this.findUnique({ where: args.where });
      if (existing) {
        return this.update({ where: args.where, data: args.update });
      }
      return this.create({ data: args.create });
    },
    async groupBy(args: any) {
      // Simple groupBy implementation for referral stats
      const { by, _sum, _count, orderBy, take } = args;
      let q = supabase.from(table).select(`${by.join(',')}, ${Object.keys(_sum || {})[0] || 'id'}`);
      
      if (orderBy) {
        const col = Object.keys(orderBy)[0];
        const dir = orderBy[col] === 'desc' ? { ascending: false } : { ascending: true };
        q = q.order(col, dir);
      }
      
      if (take) {
        q = q.limit(take);
      }
      
      const { data, error } = await q;
      if (error) throw error;
      
      // Group the results
      const grouped: any = {};
      (data || []).forEach((row: any) => {
        const key = by.map((field: string) => row[field]).join('|');
        if (!grouped[key]) {
          grouped[key] = {};
          by.forEach((field: string) => {
            grouped[key][field] = row[field];
          });
          if (_sum) {
            const sumField = Object.keys(_sum)[0];
            grouped[key]._sum = { [sumField]: 0 };
          }
          if (_count) {
            grouped[key]._count = { id: 0 };
          }
        }
        
        if (_sum) {
          const sumField = Object.keys(_sum)[0];
          grouped[key]._sum[sumField] += Number(row[sumField] || 0);
        }
        if (_count) {
          grouped[key]._count.id += 1;
        }
      });
      
      return Object.values(grouped);
    },
  };
}

const prismaCompat: any = {
  $queryRawUnsafe: async (sql: string, ...params: any[]) => {
    const { rows } = await pgQuery(sql, params);
    return rows;
  },
  $transaction: async (fn: (tx: any) => Promise<any>) => {
    // Not a real transaction; runs against the same adapter
    return fn(prismaCompat);
  },
};

for (const model of Object.keys(modelToTable)) {
  prismaCompat[model] = tableApi(model);
}

export default prismaCompat as any;