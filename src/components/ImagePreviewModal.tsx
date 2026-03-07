interface ImagePreviewModalProps {
  dataUri: string;
  winPath: string;
  onInsert: () => void;
  onClose: () => void;
}

export default function ImagePreviewModal({
  dataUri,
  winPath,
  onInsert,
  onClose,
}: ImagePreviewModalProps) {
  const fileName = winPath.split(/[\\/]/).pop() ?? winPath;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
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
          maxWidth: "80vw",
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
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <span
            className="text-xs truncate"
            style={{ color: "var(--ezy-text-muted)", maxWidth: 400 }}
            title={winPath}
          >
            {fileName}
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={onInsert}
              className="text-xs px-3 py-1 rounded"
              style={{
                backgroundColor: "var(--ezy-accent)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
              }}
            >
              Insert path
            </button>
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
