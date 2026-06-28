import "@fontsource/geist-sans/latin.css";
import "./globals.css";
import { useEffect } from "react";
import { KbUpload } from "./components/KbUpload";
import { KbFileList } from "./components/KbFileList";
import { useKbFiles } from "./hooks/use-kb-files";

function App() {
  const {
    uploadMsg,
    uploadStatus,
    selectedFile,
    kbUploading,
    kbFilesLoading,
    kbFilesError,
    kbDeleteError,
    kbDeletingKey,
    kbFiles,
    kbHealthError,
    checkKbHealth,
    fetchKbFiles,
    deleteKbFile,
    handleFileInput,
  } = useKbFiles();

  useEffect(() => {
    (async () => {
      const ok = await checkKbHealth();
      if (ok) {
        fetchKbFiles();
      }
    })();
  }, []);

  return (
    <div className="h-screen flex flex-col bg-linear-to-b from-slate-50 to-slate-100">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-purple-600">
              <span className="text-white font-bold text-sm">KB</span>
            </div>
            <h1 className="text-lg font-semibold text-slate-900">
              Knowledge Base
            </h1>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4 flex flex-col gap-4">
        <KbUpload
          selectedFile={selectedFile}
          kbUploading={kbUploading}
          uploadMsg={uploadMsg}
          uploadStatus={uploadStatus}
          onFileSelect={handleFileInput}
        />

        <KbFileList
          kbFiles={kbFiles}
          kbFilesLoading={kbFilesLoading}
          kbFilesError={kbFilesError}
          kbDeleteError={kbDeleteError}
          kbHealthError={kbHealthError}
          kbDeletingKey={kbDeletingKey}
          onRefresh={async () => {
            const ok = await checkKbHealth();
            if (ok) fetchKbFiles();
          }}
          onDelete={deleteKbFile}
        />
      </div>
    </div>
  );
}

export default App;
