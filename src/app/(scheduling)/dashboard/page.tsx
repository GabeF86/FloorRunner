export default function DashboardPage() {
  return (
    <div style={{ padding: '32px 40px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>Dashboard</h1>
      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Welcome to the FloorRunner Scheduling Platform.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginTop: 32 }}>
        {[
          { label: "Today's Staffing", value: '—', color: '#0ea5e9' },
          { label: 'OpenCall Slots', value: '—', color: '#f87171' },
          { label: 'Pending Requests', value: '—', color: '#fbbf24' },
          { label: 'Upcoming Schedules', value: '—', color: '#10b981' },
        ].map((card) => (
          <div key={card.label} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '20px 24px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>{card.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: card.color }}>{card.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
