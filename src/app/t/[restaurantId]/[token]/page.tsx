'use client';

import { useEffect, useState } from 'react';
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
  const [orderId, setOrderId] = useState('');
  const [orderStatus, setOrderStatus] = useState<OrderStatus | null>(null);
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
            }
          : prev
      );
      // If table just became available, clear any stale order satisfied state.
    });
  };

  const createSession = async (rid: string, token: string, tableData: any) => {
    try {
      const sessionsRef = collection(db, `restaurants/${rid}/sessions`);
      const q = query(sessionsRef, where('tableTokenId', '==', token), where('status', '==', 'active'));
      const existing = await getDocs(q);
      if (!existing.empty) {
        setSessionId(existing.docs[0].id);
        return;
      }
      const sessionDoc = await addDoc(sessionsRef, {
        tableTokenId: token,
        tableId: tableData.tableId,
        tableName: tableData.tableName,
        status: 'active',
        createdAt: serverTimestamp(),
      });
      setSessionId(sessionDoc.id);
    } catch (err) {
      console.error('Error creating session:', err);
    }
  };

  const isTableOpen = () => {
    return !tableInfo || tableInfo.status === 'available';
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

  // ── Table occupied gate (the core business rule) ──
  if (!isTableOpen()) {
    return (
      <div className="container waiter-screen">
        <div className="header">
          <h1>{config?.name || 'Restaurant'}</h1>
          <p>Table: {tableInfo?.tableName} | {tableInfo?.floorName}</p>
        </div>
        <div className="waiter-card">
          <div className="waiter-icon">⏳</div>
          <h2>Please Wait</h2>
          <p>This table is currently occupied and the bill has not been paid yet.</p>
          <p className="waiter-sub">
            Once the owner/manager completes the payment, you will be able to order from this table.
          </p>
          {(tableInfo?.runningTotal ?? 0) > 0 && (
            <p className="waiter-total">
              Current bill: {config?.currencySymbol || 'Rs'} {(tableInfo?.runningTotal ?? 0).toFixed(0)}
            </p>
          )}
        </div>
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
    </div>
  );
}
