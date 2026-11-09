export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <div className="workspace-loading" role="status">
      <span className="sr-only">{label}</span>
      <div className="loading-tile">
        <span />
        <span />
        <span />
      </div>
      <div className="loading-tile">
        <span />
        <span />
        <span />
      </div>
      <div className="loading-tile">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
