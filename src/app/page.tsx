'use client';

import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  doc,
  getDoc,
  query,
  orderBy,
} from 'firebase/firestore';

interface TableDoc {
  token: string;
  tableId?: number;
  tableName?: string;
  floorId?: number;
  floorName?: string;
  capacity?: number;
  isActive?: boolean;
  status?: string;
  activeOrderId?: number;
  runningTotal?: number;
  activeSessionId?: string;
}

interface MenuItem {
  id: string;
  localId?: number;
  groupId?: number;
  groupName?: string;
  name?: string;
  price?: number;
  imageUrl?: string;
  isAvailable?: boolean;
}

interface OrderItem {
  menuItemId?: number;
  menuItemName?: string;
  quantity?: number;
  unitPrice?: number;
}

interface QROrder {
  id: string;
  qrOrderId?: string;
  tableName?: string;
  tableId?: number;
  status?: string;
  items?: OrderItem[];
  totalAmount?: number;
  specialInstructions?: string;
  createdAt?: { seconds: number };
}

interface RestaurantConfig {
  name?: string;
  address?: string;
  phone?: string;
  currencySymbol?: string;
  logoUrl?: string;
}

const KITCHEN_STATUSES = new Set(['accepted', 'preparing', 'ready', 'served']);
type View = 'overview' | 'tables' | 'menu';

export default function AdminDashboard() {
  const [rid, setRid] = useState('');
  const [view, setView] = useState<View>('overview');
  const [config, setConfig] = useState<RestaurantConfig | null>(null);
  const [tables, setTables] = useState<TableDoc[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<QROrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('rid');
    if (r) {
      setRid(r);
    }
  }, []);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError('');

    const restRef = doc(db, 'restaurants', rid);
    getDoc(restRef)
      .then((snap) => setConfig(snap.exists() ? snap.data()?.config : null))
      .catch(() => setError('Could not connect to this restaurant.'));

    const unsubTables = onSnapshot(
      collection(db, `restaurants/${rid}/tables`),
      (snap) => {
        const items = snap.docs.map((d) => ({ token: d.id, ...d.data() })) as TableDoc[];
        items.sort((a, b) => (a.tableName ?? '').localeCompare(b.tableName ?? '', undefined, { numeric: true }));
        setTables(items);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setError('Could not load tables.');
        setLoading(false);
      }
    );

    const unsubMenu = onSnapshot(
      query(collection(db, `restaurants/${rid}/menu`), orderBy('sortOrder')),
      (snap) => setMenu(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as MenuItem[])
    );

    const unsubOrders = onSnapshot(
      collection(db, `restaurants/${rid}/orders`),
      (snap) => setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as QROrder[])
    );

    return () => {
      unsubTables();
      unsubMenu();
      unsubOrders();
    };
  }, [rid]);

  const tableStats = useMemo(() => {
    const map = new Map<string, { cart: number; cartTotal: number; kitchen: number; kitchenTotal: number }>();
    for (const t of tables) map.set(t.tableName ?? t.token, { cart: 0, cartTotal: 0, kitchen: 0, kitchenTotal: 0 });
    for (const o of orders) {
      const key = o.tableName ?? o.tableId?.toString() ?? '';
      if (!key) continue;
      const qty = (o.items ?? []).reduce((s, i) => s + (i.quantity ?? 0), 0);
      const total = o.totalAmount ?? 0;
      const cur = map.get(key) ?? { cart: 0, cartTotal: 0, kitchen: 0, kitchenTotal: 0 };
      if (o.status === 'pending') {
        cur.cart += qty;
        cur.cartTotal += total;
      } else if (o.status && KITCHEN_STATUSES.has(o.status)) {
        cur.kitchen += qty;
        cur.kitchenTotal += total;
      }
      map.set(key, cur);
    }
    return map;
  }, [tables, orders]);

  const ordersByTable = useMemo(() => {
    const map = new Map<string, QROrder[]>();
    for (const o of orders) {
      const key = o.tableName ?? o.tableId?.toString() ?? 'Unknown';
      const arr = map.get(key) ?? [];
      arr.push(o);
      map.set(key, arr);
    }
    return map;
  }, [orders]);

  const occupiedTables = tables.filter((t) => t.status !== 'available').length;
  const availableTables = tables.length - occupiedTables;
  const pendingOrders = useMemo(() => orders.filter((o) => o.status === 'pending'), [orders]);
  const totalCart = pendingOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0);
  const totalKitchen = orders
    .filter((o) => o.status && KITCHEN_STATUSES.has(o.status))
    .reduce((s, o) => s + (o.totalAmount ?? 0), 0);
  const cartItems = pendingOrders.reduce((s, o) => s + (o.items ?? []).reduce((a, i) => a + (i.quantity ?? 0), 0), 0);
  const kitchenItems = orders
    .filter((o) => o.status && KITCHEN_STATUSES.has(o.status))
    .reduce((s, o) => s + (o.items ?? []).reduce((a, i) => a + (i.quantity ?? 0), 0), 0);

  const floors = useMemo(() => {
    const m = new Map<string, TableDoc[]>();
    for (const t of tables) {
      const f = t.floorName || 'Other';
      const arr = m.get(f) ?? [];
      arr.push(t);
      m.set(f, arr);
    }
    return Array.from(m.entries());
  }, [tables]);

  const currency = config?.currencySymbol || 'Rs';

  const statusTone = (status?: string) => {
    switch (status) {
      case 'available': return 'ok';
      case 'occupied': return 'bad';
      case 'payment': return 'warn';
      default: return 'neutral';
    }
  };

  return (
    <div className="admin">
      {/* ── Brand header ── */}
      <header className="admin-brand">
        <div className="admin-brand-inner">
          <div className="admin-brand-left">
            {config?.logoUrl ? (
              <img src={config.logoUrl} alt="logo" className="admin-brand-logo" />
            ) : (
              <div className="admin-brand-logo admin-brand-logo-fallback">🍽️</div>
            )}
            <div>
              <h1>{config?.name || 'Restaurant Admin'}</h1>
              <p>{config?.address || `${rid || 'Enter a Restaurant ID'}`}</p>
            </div>
          </div>
          <div className="admin-live">
            <span className="live-dot" />
            <span>Live</span>
          </div>
        </div>
      </header>

      {/* ── Restaurant selector ── */}
      <form
        className="admin-rid-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = (e.currentTarget.elements.namedItem('rid') as HTMLInputElement)?.value.trim();
          if (v) setRid(v);
        }}
      >
        <div className="admin-rid-field">
          <span>🔑</span>
          <input name="rid" defaultValue={rid} placeholder="Restaurant ID — e.g. 862202ff03abb91c" />
        </div>
        <button type="submit">Load Dashboard</button>
      </form>

      {error && <div className="admin-error">{error}</div>}
      {loading && !tables.length && !error && <div className="loading">Loading dashboard…</div>}

      {rid && !loading && (
        <>
          {/* ── KPI cards ── */}
          <div className="admin-kpis">
            <div className="kpi">
              <div className="kpi-icon cart">🛒</div>
              <div className="kpi-meta">
                <span>In Cart</span>
                <b>{currency} {totalCart.toFixed(0)}</b>
                <small>{cartItems} items · {pendingOrders.length} open</small>
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-icon kitchen">👨‍🍳</div>
              <div className="kpi-meta">
                <span>In Kitchen</span>
                <b>{currency} {totalKitchen.toFixed(0)}</b>
                <small>{kitchenItems} items being prepared</small>
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-icon tables">🪑</div>
              <div className="kpi-meta">
                <span>Tables</span>
                <b>{occupiedTables} / {tables.length}</b>
                <small>{availableTables} available</small>
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-icon menu">📋</div>
              <div className="kpi-meta">
                <span>Menu Items</span>
                <b>{menu.length}</b>
                <small>{menu.filter((m) => m.isAvailable !== false).length} available</small>
              </div>
            </div>
          </div>

          {/* ── Nav tabs ── */}
          <nav className="admin-nav">
            <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>Overview</button>
            <button className={view === 'tables' ? 'active' : ''} onClick={() => setView('tables')}>Tables</button>
            <button className={view === 'menu' ? 'active' : ''} onClick={() => setView('menu')}>Menu</button>
          </nav>

          {view === 'overview' && (
            <div className="admin-overview">
              <section className="admin-section">
                <div className="section-title"><h2>Restaurant Floor</h2><span>{tables.length} tables</span></div>
                {floors.map(([floor, tbls]) => (
                  <div key={floor} className="floor-block">
                    <div className="floor-name">📍 {floor}</div>
                    <div className="table-grid">
                      {tbls.map((t) => {
                        const st = tableStats.get(t.tableName ?? t.token);
                        const hasCart = (st?.cart ?? 0) > 0;
                        const hasKitchen = (st?.kitchen ?? 0) > 0;
                        return (
                          <div key={t.token} className={`table-card tone-${statusTone(t.status)}`}>
                            <div className="table-card-top">
                              <span className="table-name">{t.tableName || t.token.slice(0, 6)}</span>
                              <span className="table-pill">{t.status || 'unknown'}</span>
                            </div>
                            <div className="table-counts">
                              <div className={`tbl-count cart ${hasCart ? 'on' : ''}`}>
                                <span>Cart</span>
                                <b>{st?.cart ?? 0}</b>
                              </div>
                              <div className={`tbl-count kitchen ${hasKitchen ? 'on' : ''}`}>
                                <span>Kitchen</span>
                                <b>{st?.kitchen ?? 0}</b>
                              </div>
                            </div>
                            {(t.runningTotal ?? 0) > 0 ? (
                              <div className="table-total">{currency} {(t.runningTotal || 0).toFixed(0)}</div>
                            ) : null}
                          </div>
                        );
                      })}
                      {tbls.length === 0 && <div className="empty">No tables on this floor.</div>}
                    </div>
                  </div>
                ))}
                {floors.length === 0 && <div className="empty">No tables found for this restaurant yet.</div>}
              </section>
            </div>
          )}

          {view === 'tables' && (
            <section className="admin-section">
              <div className="section-title"><h2>All Tables</h2><span>{tables.length}</span></div>
              <div className="table-grid">
                {tables.map((t) => {
                  const st = tableStats.get(t.tableName ?? t.token);
                  const tblOrders = ordersByTable.get(t.tableName ?? '') ?? [];
                  return (
                    <div key={t.token} className={`table-card tone-${statusTone(t.status)}`}>
                      <div className="table-card-top">
                        <span className="table-name">{t.tableName || t.token.slice(0, 6)}</span>
                        <span className="table-pill">{t.status || 'unknown'}</span>
                      </div>
                      {t.floorName && <div className="table-floor-sub">{t.floorName} · cap {t.capacity ?? '-'}</div>}
                      <div className="table-counts">
                        <div className={`tbl-count cart ${(st?.cart ?? 0) > 0 ? 'on' : ''}`}>
                          <span>Cart</span><b>{st?.cart ?? 0}</b>
                        </div>
                        <div className={`tbl-count kitchen ${(st?.kitchen ?? 0) > 0 ? 'on' : ''}`}>
                          <span>Kitchen</span><b>{st?.kitchen ?? 0}</b>
                        </div>
                      </div>
                      <div className="table-orders">
                        {tblOrders.length === 0 && <div className="table-no-order">No QR orders</div>}
                        {tblOrders.map((o) => (
                          <div key={o.id} className="table-order-row">
                            <span className={`order-chip ${o.status}`}>{o.status}</span>
                            <span className="order-qty">
                              {(o.items ?? []).reduce((s, i) => s + (i.quantity ?? 0), 0)} items
                            </span>
                            <span className="order-amt">{currency} {(o.totalAmount ?? 0).toFixed(0)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {tables.length === 0 && <div className="empty">No tables found.</div>}
              </div>
            </section>
          )}

          {view === 'menu' && (
            <section className="admin-section">
              <div className="section-title"><h2>Menu</h2><span>{menu.length} items</span></div>
              {menuGroups()}
            </section>
          )}
        </>
      )}
    </div>
  );

  function menuGroups() {
    const groups = new Map<number, { name: string; items: MenuItem[] }>();
    for (const it of menu) {
      const gid = it.groupId ?? 0;
      const g = groups.get(gid) ?? { name: it.groupName ?? 'Other', items: [] };
      if (!g.name && it.groupName) g.name = it.groupName;
      g.items.push(it);
      groups.set(gid, g);
    }
    return Array.from(groups.values()).map((g) => (
      <div key={g.name} className="menu-group">
        <h3>{g.name}</h3>
        <div className="menu-grid">
          {g.items.map((it) => (
            <div key={it.id} className="menu-card">
              {it.imageUrl ? (
                <img src={it.imageUrl} alt={it.name} className="menu-card-img" />
              ) : (
                <div className="menu-card-img menu-card-placeholder">🍽️</div>
              )}
              <div className="menu-card-body">
                <h4>{it.name}</h4>
                <div className="menu-card-foot">
                  <b>{currency} {(it.price ?? 0).toFixed(0)}</b>
                  <span className={`menu-avail ${it.isAvailable === false ? 'off' : ''}`}>
                    {it.isAvailable === false ? 'Sold out' : 'Available'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    ));
  }
}
