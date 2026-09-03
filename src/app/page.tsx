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
  tableName?: string;
  tableId?: number;
  status?: string;
  items?: OrderItem[];
  totalAmount?: number;
  createdAt?: { seconds: number };
}

interface RestaurantConfig {
  name?: string;
  currencySymbol?: string;
}

const KITCHEN_STATUSES = new Set(['accepted', 'preparing', 'ready']);

export default function AdminDashboard() {
  const [rid, setRid] = useState('');
  const [inputRid, setInputRid] = useState('');
  const [config, setConfig] = useState<RestaurantConfig | null>(null);
  const [tables, setTables] = useState<TableDoc[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<QROrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load restaurant id from query param if present (?rid=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('rid');
    if (r) {
      setRid(r);
      setInputRid(r);
    }
  }, []);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError('');

    const restRef = doc(db, 'restaurants', rid);
    getDoc(restRef)
      .then((snap) => setConfig(snap.exists() ? snap.data()?.config : null))
      .catch(() => setError('Cannot read restaurant. Check rules.'));

    const unsubTables = onSnapshot(
      collection(db, `restaurants/${rid}/tables`),
      (snap) => {
        const items: TableDoc[] = snap.docs.map((d) => ({
          token: d.id,
          ...d.data(),
        })) as TableDoc[];
        items.sort((a, b) => (a.tableName ?? '').localeCompare(b.tableName ?? '', undefined, { numeric: true }));
        setTables(items);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setError('Failed to load tables. Check Firestore rules.');
        setLoading(false);
      }
    );

    const unsubMenu = onSnapshot(
      query(collection(db, `restaurants/${rid}/menu`), orderBy('sortOrder')),
      (snap) => {
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as MenuItem[];
        setMenu(items);
      }
    );

    const unsubOrders = onSnapshot(
      collection(db, `restaurants/${rid}/orders`),
      (snap) => {
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as QROrder[];
        setOrders(items);
      }
    );

    return () => {
      unsubTables();
      unsubMenu();
      unsubOrders();
    };
  }, [rid]);

  // Aggregate orders per table.
  const tableStats = useMemo(() => {
    const map = new Map<
      string,
      { cart: number; cartTotal: number; kitchen: number; kitchenTotal: number }
    >();
    for (const t of tables) {
      const key = t.tableName ?? t.token;
      map.set(key, { cart: 0, cartTotal: 0, kitchen: 0, kitchenTotal: 0 });
    }
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

  const totalCart = useMemo(
    () => orders.filter((o) => o.status === 'pending').reduce((s, o) => s + (o.totalAmount ?? 0), 0),
    [orders]
  );
  const totalKitchen = useMemo(
    () =>
      orders
        .filter((o) => o.status && KITCHEN_STATUSES.has(o.status))
        .reduce((s, o) => s + (o.totalAmount ?? 0), 0),
    [orders]
  );

  const menuGroups = useMemo(() => {
    const groups = new Map<number, { name: string; items: MenuItem[] }>();
    for (const it of menu) {
      const gid = it.groupId ?? 0;
      const g = groups.get(gid) ?? { name: it.groupName ?? 'Other', items: [] };
      if (!g.name && it.groupName) g.name = it.groupName;
      g.items.push(it);
      groups.set(gid, g);
    }
    return Array.from(groups.values());
  }, [menu]);

  const statusColor = (status?: string) => {
    switch (status) {
      case 'available':
        return 'var(--success)';
      case 'occupied':
        return 'var(--danger)';
      case 'payment':
        return 'var(--warning)';
      default:
        return 'var(--secondary)';
    }
  };

  const statusLabel = (status?: string) => {
    if (!status) return 'Unknown';
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  return (
    <div className="admin">
      <div className="admin-header">
        <div className="admin-title">
          <span className="admin-logo">🏪</span>
          <div>
            <h1>{config?.name || 'QR Menu Admin'}</h1>
            <p>Live dashboard — tables, cart and kitchen status</p>
          </div>
        </div>
        <div className="admin-summary">
          <div className="summary-card cart"><span>In Cart</span><b>{totalCart.toFixed(0)}</b></div>
          <div className="summary-card kitchen"><span>In Kitchen</span><b>{totalKitchen.toFixed(0)}</b></div>
        </div>
      </div>

      <form
        className="admin-rid-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (inputRid.trim()) setRid(inputRid.trim());
        }}
      >
        <input
          value={inputRid}
          onChange={(e) => setInputRid(e.target.value)}
          placeholder="Enter Restaurant ID (e.g. 862202ff03abb91c)"
        />
        <button type="submit">Load Dashboard</button>
      </form>

      {error && <div className="admin-error">{error}</div>}

      {loading && !tables.length && !error && <div className="loading">Loading dashboard...</div>}

      {rid && !loading && (
        <>
          <section className="admin-section">
            <h2>Tables</h2>
            <div className="table-grid">
              {tables.map((t) => {
                const stats = tableStats.get(t.tableName ?? t.token);
                const hasCart = (stats?.cart ?? 0) > 0;
                const hasKitchen = (stats?.kitchen ?? 0) > 0;
                return (
                  <div
                    key={t.token}
                    className={`table-card ${t.status === 'available' ? 'open' : 'busy'}`}
                    style={{ borderTopColor: statusColor(t.status) }}
                  >
                    <div className="table-card-top">
                      <span className="table-name">{t.tableName || t.token.slice(0, 6)}</span>
                      <span
                        className="table-status"
                        style={{ color: statusColor(t.status), borderColor: statusColor(t.status) }}
                      >
                        {statusLabel(t.status)}
                      </span>
                    </div>
                    {t.floorName && <div className="table-floor">{t.floorName}</div>}
                    <div className="table-counts">
                      <div className={`count-box cart ${hasCart ? 'active' : ''}`}>
                        <span className="count-label">Cart</span>
                        <b>{stats?.cart ?? 0}</b>
                        <span className="count-amount">{(stats?.cartTotal ?? 0).toFixed(0)}</span>
                      </div>
                      <div className={`count-box kitchen ${hasKitchen ? 'active' : ''}`}>
                        <span className="count-label">Kitchen</span>
                        <b>{stats?.kitchen ?? 0}</b>
                        <span className="count-amount">{(stats?.kitchenTotal ?? 0).toFixed(0)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {tables.length === 0 && <div className="empty">No tables found.</div>}
            </div>
          </section>

          <section className="admin-section">
            <h2>Menu</h2>
            {menuGroups.map((g) => (
              <div key={g.name} className="menu-group">
                <h3>{g.name}</h3>
                <div className="menu-grid">
                  {g.items.map((it) => (
                    <div key={it.id} className="menu-item">
                      {it.imageUrl ? (
                        <img src={it.imageUrl} alt={it.name} className="menu-item-image" />
                      ) : (
                        <div className="menu-item-placeholder">🍽️</div>
                      )}
                      <div className="menu-item-info">
                        <h3 className="menu-item-name">{it.name}</h3>
                        <div className="menu-item-footer">
                          <span className="menu-item-price">
                            {config?.currencySymbol || 'Rs'} {(it.price ?? 0).toFixed(0)}
                          </span>
                          <span className={`availability ${it.isAvailable === false ? 'off' : ''}`}>
                            {it.isAvailable === false ? 'Sold Out' : 'Available'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {menu.length === 0 && <div className="empty">No menu items found.</div>}
          </section>
        </>
      )}
    </div>
  );
}
