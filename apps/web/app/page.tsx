export default function Home() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>OpenEuler</h1>
      <p>Web placeholder — daemon listens on http://localhost:8787/health</p>
    </main>
  );
}
