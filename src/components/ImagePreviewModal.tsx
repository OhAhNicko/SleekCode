interface ImagePreviewModalProps {
  dataUri: string;
  winPath: string;
  onInsert?: () => void;
  onClose: () => void;
  onDelete?: () => void;
}

export default function ImagePreviewModal({
  dataUri,
  winPath,
  onInsert,
  onClose,
  onDelete,
}: ImagePreviewModalProps) {
  const fileName = winPath.split(/[\\/]/).pop() ?? winPath;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        backgroundColor: "rgba(0,0,0,0.7)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          padding: 16,
          maxWidth: 448,
          width: "100%",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <span
            className="text-xs truncate"
            style={{ color: "var(--ezy-text-muted)", maxWidth: 400 }}
            title={winPath}
          >
            {fileName}
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
            {onInsert && (
              <button
                onClick={onInsert}
                className="text-xs px-3 py-1 rounded"
                style={{
                  backgroundColor: "#059669",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: 500,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 2 V8 M3 5 L6 8 L9 5 M2.5 10 H9.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Insert path
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => { onDelete(); onClose(); }}
                title="Delete screenshot"
                aria-label="Delete screenshot"
                style={{
                  width: 26,
                  height: 26,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "var(--ezy-surface)",
                  color: "#dc2626",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 4,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 4 H9 M4.5 4 V2.5 H7.5 V4 M4 4 L4.5 10 H7.5 L8 4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-xs px-3 py-1 rounded"
              style={{
                backgroundColor: "var(--ezy-surface)",
                color: "var(--ezy-text-muted)",
                border: "1px solid var(--ezy-border)",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Image */}
        <img
          src={dataUri}
          alt="Clipboard screenshot"
          style={{
            maxWidth: "100%",
            maxHeight: "calc(80vh - 80px)",
            objectFit: "contain",
            borderRadius: 4,
          }}
        />
      </div>
    </div>
  );
}
