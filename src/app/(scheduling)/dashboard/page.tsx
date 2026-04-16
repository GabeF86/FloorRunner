export default function DashboardPage() {
  return (
    <div style={{ padding: '32px 40px', background: '#f8fafc', minHeight: '100%', color: '#0f172a' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>Dashboard</h1>
      <p style={{ fontSize: 14, color: '#64748b' }}>Welcome to the FloorRunner Scheduling Platform.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginTop: 32 }}>
        {[
          { label: "Today's Staffing", value: '—', color: '#0ea5e9' },
          { label: 'OpenCall Slots', value: '—', color: '#f87171' },
          { label: 'Pending Requests', value: '—', color: '#fbbf24' },
          { label: 'Upcoming Schedules', value: '—', color: '#10b981' },
        ].map((card) => (
          <div key={card.label} style={{
            background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12,
            padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>{card.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: card.color }}>{card.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
