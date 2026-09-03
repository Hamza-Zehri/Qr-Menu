'use client';

import { useEffect, useRef, useState } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  addDoc,
  serverTimestamp,
  getDocs,
  getDoc,
} from 'firebase/firestore';

interface MenuItem {
  id: string;
  localId: number;
  groupId: number;
  groupName: string;
  name: string;
  price: number;
  description?: string;
  imageUrl?: string;
  isAvailable: boolean;
  sortOrder: number;
}

interface CartItem {
  menuItem: MenuItem;
  quantity: number;
  notes: string;
}

interface TableInfo {
  tableId: number;
  tableName: string;
  floorId: number;
  floorName: string;
  capacity: number;
  isActive: boolean;
  status: string; // 'available' | 'occupied' | 'payment'
  activeOrderId?: number;
  runningTotal?: number;
  grandTotal?: number;
}

interface RestaurantConfig {
  name: string;
  address: string;
  phone: string;
  logoUrl?: string;
  currencySymbol: string;
  taxPercent: number;
  serviceChargePercent: number;
  allowInstructions: boolean;
}
interface OrderStatus {
  status: string;
  posOrderId?: number;
}

export default function QRMenuPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restaurantId, setRestaurantId] = useState('');
  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null);
  const [config, setConfig] = useState<RestaurantConfig | null>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [sessionId, setSessionId] = useState('');
  // The ID of the active session for this table that THIS phone owns/stored.
  // Used to let the ordering phone keep ordering while the table is occupied.
  const ownerSessionIdRef = useRef('');
  const [orderId, setOrderId] = useState('');
  const [orderStatus, setOrderStatus] = useState<OrderStatus | null>(null);
  const [placedOrder, setPlacedOrder] = useState<{
    id: string;
    items: { name: string; qty: number; price: number }[];
    total: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    // [restaurantId]/[token] from URL
    const pathParts = window.location.pathname.split('/');
    const token = pathParts[pathParts.length - 1];
    const rid = pathParts[pathParts.length - 2];
    if (token && rid) {
      setRestaurantId(rid);
      loadData(rid, token);
    } else {
      setError('Invalid QR code');
      setLoading(false);
    }
  }, []);

  // Live menu subscription so name/price/image changes appear in real time
  // without reloading the page.
  useEffect(() => {
    if (!restaurantId) return;
    const cs = collection(db, `restaurants/${restaurantId}/menu`);
    const q = query(cs, orderBy('sortOrder'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = (snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as MenuItem[]).filter((i) => i.isAvailable !== false);
        setMenuItems(items);
      },
      (err) => console.error('Error streaming menu:', err)
    );
    return () => unsub();
  }, [restaurantId]);

  const loadData = async (rid: string, token: string) => {
    try {
      const restDoc = await getDoc(doc(db, 'restaurants', rid));
      if (!restDoc.exists()) {
        setError('Restaurant not found');
        setLoading(false);
        return;
      }
      const data = restDoc.data();
      setConfig(data.config);

      const tableRef = doc(db, `restaurants/${rid}/tables/${token}`);
      const tableSnapshot = await getDoc(tableRef);
      if (!tableSnapshot.exists()) {
        setError('Table not found');
        setLoading(false);
        return;
      }

      const td = tableSnapshot.data();
      setTableInfo({
        tableId: td.tableId,
        tableName: td.tableName,
        floorId: td.floorId,
        floorName: td.floorName,
        capacity: td.capacity,
        isActive: td.isActive,
        status: td.status ?? 'available',
        activeOrderId: td.activeOrderId,
        runningTotal: td.runningTotal,
        grandTotal: td.grandTotal,
      });

      await listenTableStatus(rid, token);
      await createSession(rid, token, td);
      setLoading(false);
    } catch (err) {
      console.error('Error loading table:', err);
      setError('Failed to load table information');
      setLoading(false);
    }
  };

  // Real-time table status: when occupied/not paid -> customer sees "please wait".
  // Only the POS owner frees the table after payment; when freed, ordering unlocks.
  const listenTableStatus = (rid: string, token: string) => {
    const tableRef = doc(db, `restaurants/${rid}/tables/${token}`);
    return onSnapshot(tableRef, (snap) => {
      if (!snap.exists()) return;
      const td = snap.data();
      setTableInfo((prev) =>
        prev
          ? {
              ...prev,
              status: td.status ?? 'available',
              activeOrderId: td.activeOrderId,
              runningTotal: td.runningTotal,
              grandTotal: td.grandTotal,
            }
          : prev
      );
      // If table just became available, clear any stale order satisfied state.
    });
  };

  const createSession = async (rid: string, token: string, tableData: any) => {
    try {
      const sessionsRef = collection(db, `restaurants/${rid}/sessions`);
      // Look up any active session for this table.
      const q = query(sessionsRef, where('tableTokenId', '==', token), where('status', '==', 'active'));
      const existing = await getDocs(q);
      const activeSession = existing.empty ? null : existing.docs[0];
      const activeId = activeSession ? activeSession.id : '';

      // This phone remembers the session it started with (unless the session
      // has since been paid/closed). The owner phone keeps ordering after the
      // table turns occupied; other phones see the table as busy.
      let storedId = '';
      try { storedId = window.localStorage.getItem(`${rid}:${token}:session`) || ''; } catch {}

      if (!activeSession) {
        // No active session for this phone's token.
        // IMPORTANT: if the table is already occupied by another phone (under a
        // different token or not yet paid), this phone must NOT claim ownership —
        // it should see the "Please Wait" screen until the owner frees the table.
        if (tableData.status && tableData.status !== 'available') {
          ownerSessionIdRef.current = '';
          setSessionId(storedId || '');
          return;
        }
        // Table is available: create a session, mark it owned by this phone.
        const sessionDoc = await addDoc(sessionsRef, {
          tableTokenId: token,
          tableId: tableData.tableId,
          tableName: tableData.tableName,
          status: 'active',
          createdAt: serverTimestamp(),
        });
        setSessionId(sessionDoc.id);
        ownerSessionIdRef.current = sessionDoc.id;
        try { window.localStorage.setItem(`${rid}:${token}:session`, sessionDoc.id); } catch {}
        return;
      }

      if (activeId && storedId === activeId) {
        // This phone owns the active session -> it may keep ordering.
        setSessionId(activeId);
        ownerSessionIdRef.current = activeId;
        return;
      }

      // An active session exists that this phone did not start.
      setSessionId(storedId || activeId);
      ownerSessionIdRef.current = '';
    } catch (err) {
      console.error('Error creating session:', err);
    }
  };

  const isTableOpen = () => {
    if (!tableInfo) return false;
    if (tableInfo.status === 'available') return true;
    // Occupied/busy: only the phone that owns the active session may order.
    if (ownerSessionIdRef.current !== '') {
      // This phone owns a running session (it has already ordered on this table).
      return true;
    }
    return false;
  };

  const addToCart = (item: MenuItem) => {
    if (!isTableOpen()) return;
    const existing = cart.find((c) => c.menuItem.id === item.id);
    if (existing) {
      setCart(
        cart.map((c) =>
          c.menuItem.id === item.id ? { ...c, quantity: c.quantity + 1 } : c
        )
      );
    } else {
      setCart([...cart, { menuItem: item, quantity: 1, notes: '' }]);
    }
  };

  const updateQuantity = (itemId: string, delta: number) => {
    if (!isTableOpen()) return;
    const existing = cart.find((c) => c.menuItem.id === itemId);
    if (existing) {
      const newQty = existing.quantity + delta;
      if (newQty <= 0) {
        setCart(cart.filter((c) => c.menuItem.id !== itemId));
      } else {
        setCart(
          cart.map((c) =>
            c.menuItem.id === itemId ? { ...c, quantity: newQty } : c
          )
        );
      }
    }
  };

  const getCartTotal = () => {
    return cart.reduce((sum, item) => sum + item.menuItem.price * item.quantity, 0);
  };

  const submitOrder = async () => {
    if (cart.length === 0 || submitting) return;
    if (!isTableOpen()) {
      alert('Please wait — this table is currently occupied.');
      return;
    }
    setSubmitting(true);
    try {
      const items = cart.map((item) => ({
        menuItemId: item.menuItem.localId,
        menuItemName: item.menuItem.name,
        quantity: item.quantity,
        unitPrice: item.menuItem.price,
        notes: item.notes,
      }));

      const orderRef = collection(db, `restaurants/${restaurantId}/orders`);
      const orderDoc = await addDoc(orderRef, {
        qrOrderId: crypto.randomUUID(),
        sessionId,
        tableId: tableInfo?.tableId,
        tableName: tableInfo?.tableName,
        items,
        specialInstructions,
        status: 'pending',
        totalAmount: getCartTotal(),
        currencySymbol: config?.currencySymbol || 'Rs',
        source: 'qr',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setOrderId(orderDoc.id);
      setPlacedOrder({
        id: orderDoc.id,
        items: cart.map((c) => ({
          name: c.menuItem.name,
          qty: c.quantity,
          price: c.menuItem.price,
        })),
        total: getCartTotal(),
      });
      setCart([]);
      setSpecialInstructions('');
    } catch (err) {
      console.error('Error submitting order:', err);
      alert('Failed to submit order. The owner has not confirmed yet, please wait.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="loading">Loading menu...</div>;
  }

  if (error) {
    return <div className="loading">{error}</div>;
  }

  // ── Order confirmation: show exactly what the customer ordered ──
  if (placedOrder) {
    return (
      <div className="container confirmation">
        <div className="confirmation-card">
          <div className="confirmation-check">✓</div>
          <h1>Order Received!</h1>
          <p className="confirmation-sub">
            {config?.name || 'Restaurant'} — your order has been sent to the kitchen.
          </p>
          <div className="confirmation-table">
            Table {tableInfo?.tableName}
          </div>

          <div className="confirmation-items">
            {placedOrder.items.map((it, i) => (
              <div key={i} className="confirmation-row">
                <span className="conf-row-name">{it.qty}× {it.name}</span>
                <span className="conf-row-price">
                  {config?.currencySymbol || 'Rs'} {(it.price * it.qty).toFixed(0)}
                </span>
              </div>
            ))}
          </div>

          <div className="confirmation-total">
            <span>Total</span>
            <b>{config?.currencySymbol || 'Rs'} {placedOrder.total.toFixed(0)}</b>
          </div>

          <p className="confirmation-hint">
            Please wait while the restaurant confirms and prepares your order.
          </p>
          <button
            className="btn-primary"
            onClick={() => setPlacedOrder(null)}
            style={{ marginTop: '16px', width: '100%' }}
          >
            View Menu Again
          </button>
        </div>
      </div>
    );
  }

  // ── Table occupied gate (the core business rule) ──
  if (!isTableOpen()) {
    const bill = (tableInfo?.grandTotal ?? 0) > 0
      ? tableInfo!.grandTotal!
      : (tableInfo?.runningTotal ?? 0);
    return (
      <div className="container waiter-screen">
        <div className="header">
          <h1>{config?.name || 'Restaurant'}</h1>
          <p>Table: {tableInfo?.tableName} | {tableInfo?.floorName}</p>
        </div>
        <div className="waiter-card">
          <div className="waiter-icon">⏳</div>
          <h2>Please Wait</h2>
          <p className="waiter-sub">
            This table is currently occupied and the bill has not been paid yet.
          </p>
          <div className="waiter-note">
            <span className="waiter-note-icon">🔔</span>
            <div className="waiter-note-text">
              <b>Keep this page open.</b>
              <span>
                Your screen updates automatically — please <b>don&apos;t refresh or
                rescan</b>. The moment the owner/manager settles the bill, you can
                start ordering right here.
              </span>
            </div>
          </div>
          {bill > 0 && (
            <div className="waiter-bill">
              <span className="waiter-bill-label">Current Bill</span>
              <span className="waiter-bill-amount">
                {config?.currencySymbol || 'Rs'} {bill.toFixed(0)}
              </span>
              <span className="waiter-bill-updates">Updates live as your order changes</span>
            </div>
          )}
          <p className="waiter-quote">
            “Good food and great company are worth the wait.” — 🍽️ Our team is
            preparing something delicious for you.
          </p>
        </div>
        <footer className="waiter-footer">
          Powered by <b>QR Menu</b> — developed by <b>Engr. Hamza Asad</b>
        </footer>
      </div>
    );
  }

  // ── Landing screen: logo + cafe name + Start Ordering ──
  if (!started) {
    return (
      <div className="container landing">
        <div className="landing-card">
          {config?.logoUrl ? (
            <img src={config.logoUrl} alt="logo" className="landing-logo" />
          ) : (
            <div className="landing-logo landing-logo-fallback">🍽️</div>
          )}
          <h1 className="landing-name">{config?.name || 'Welcome'}</h1>
          {config?.address && <p className="landing-address">{config.address}</p>}
          <div className="landing-table">
            <span>Table</span>
            <b>{tableInfo?.tableName || ''}</b>
          </div>
          <button className="btn-primary landing-btn" onClick={() => setStarted(true)}>
            Start Ordering
          </button>
          <p className="landing-hint">
            Scan again or ask your host for help. Items you order go straight to the kitchen.
          </p>
        </div>
      </div>
    );
  }

  const categories = Array.from(new Set(menuItems.map((item) => item.groupId)));
  const filteredItems = selectedCategory
    ? menuItems.filter((item) => item.groupId === selectedCategory)
    : menuItems;

  if (orderStatus) {
    return (
      <div className="container">
        <div className="header">
          <h1>{config?.name || 'Restaurant'}</h1>
          <p>Table: {tableInfo?.tableName}</p>
        </div>
        <div className={`order-status ${orderStatus.status}`}>
          <h2>Order {orderStatus.status.charAt(0).toUpperCase() + orderStatus.status.slice(1)}</h2>
          <p>Your order has been received{orderStatus.status === 'pending' ? ' and is awaiting owner confirmation.' : ' and is being prepared.'}</p>
          {orderStatus.posOrderId && <p>Order #{orderStatus.posOrderId}</p>}
        </div>
        <button
          className="btn-primary"
          onClick={() => {
            setOrderStatus(null);
            setOrderId('');
          }}
          style={{ marginTop: '16px' }}
        >
          {orderStatus.status === 'pending' ? 'Track Order' : 'Place Another Order'}
        </button>
      </div>
    );
  }

  return (
    <div className={`container ${cart.length > 0 ? 'cart-spacer' : ''}`}>
      <div className="header">
        <div className="header-brand">
          {config?.logoUrl && <img src={config.logoUrl} alt="logo" className="header-logo" />}
          <h1>{config?.name || 'Restaurant'}</h1>
        </div>
        <p>Table: {tableInfo?.tableName} | {tableInfo?.floorName}</p>
      </div>

      <div className="categories">
        <button
          className={`category-btn ${selectedCategory === null ? 'active' : ''}`}
          onClick={() => setSelectedCategory(null)}
        >
          All
        </button>
        {categories.map((catId) => {
          const item = menuItems.find((i) => i.groupId === catId);
          return (
            <button
              key={catId}
              className={`category-btn ${selectedCategory === catId ? 'active' : ''}`}
              onClick={() => setSelectedCategory(catId)}
            >
              {item?.groupName || `Category ${catId}`}
            </button>
          );
        })}
      </div>

      <div className="menu-grid">
        {filteredItems.map((item) => (
          <div key={item.id} className="menu-item">
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.name} className="menu-item-image" />
            ) : (
              <div className="menu-item-placeholder">🍽️</div>
            )}
            <div className="menu-item-info">
              <div>
                <h3 className="menu-item-name">{item.name}</h3>
                {item.description && <p className="menu-item-desc">{item.description}</p>}
              </div>
              <div className="menu-item-footer">
                <span className="menu-item-price">
                  {config?.currencySymbol || 'Rs'} {item.price.toFixed(0)}
                </span>
                <div className="quantity-controls">
                  {cart.find((c) => c.menuItem.id === item.id) ? (
                    <>
                      <button className="qty-btn" onClick={() => updateQuantity(item.id, -1)}>-</button>
                      <span className="qty-value">
                        {cart.find((c) => c.menuItem.id === item.id)?.quantity || 0}
                      </span>
                      <button className="qty-btn" onClick={() => updateQuantity(item.id, 1)}>+</button>
                    </>
                  ) : (
                    <button className="qty-btn" onClick={() => addToCart(item)}>+</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {cart.length > 0 && (
        <div className="cart">
          <div className="cart-content">
            <div className="cart-summary">
              <span className="cart-total">
                {config?.currencySymbol || 'Rs'} {getCartTotal().toFixed(0)}
              </span>
              <span className="cart-items-count">
                {cart.reduce((sum, item) => sum + item.quantity, 0)} items
              </span>
            </div>

            {config?.allowInstructions && (
              <textarea
                className="instructions-input"
                placeholder="Special instructions (optional)"
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
              />
            )}

            <button
              className="btn-primary"
              onClick={submitOrder}
              disabled={submitting}
              style={{ marginTop: '12px' }}
            >
              {submitting ? 'Submitting...' : 'Place Order'}
            </button>
          </div>
        </div>
      )}

      <footer className="menu-footer">
        Powered by <b>QR Menu</b> — developed by <b>Engr. Hamza Asad</b>
      </footer>
    </div>
  );
}
