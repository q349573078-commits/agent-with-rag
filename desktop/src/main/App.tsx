import "@fontsource/geist-sans/latin.css";
import "./globals.css";
import { Button } from "@shared/components/ui/button";
import { UploadIcon } from "lucide-react";
import { ChatArea } from "./components/ChatArea";
import { useAgentChat } from "./hooks/use-agent-chat";

function App() {
  const {
    input,
    setInput,
    thread,
    loading,
    onRun,
    resumePendingWebSearch,
  } = useAgentChat();

  const handleOpenKbWindow = () => {
    window.electronAPI?.openKbWindow();
  };

  return (
    <div className="h-screen flex flex-col bg-linear-to-b from-slate-50 to-slate-100">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-purple-600">
              <span className="text-white font-bold text-sm">AG</span>
            </div>
            <h1 className="text-lg font-semibold text-slate-900">Agent</h1>
          </div>
          <Button
            onClick={handleOpenKbWindow}
            variant="outline"
            className="gap-2"
          >
            <UploadIcon className="h-4 w-4" />
            Upload KB
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-auto">
        <ChatArea
          thread={thread}
          loading={loading}
          input={input}
          onInputChange={setInput}
          onSend={onRun}
          onResumeWebSearch={(msgId) => resumePendingWebSearch(msgId, "confirm")}
          onCancelWebSearch={(msgId) => resumePendingWebSearch(msgId, "cancel")}
        />
      </div>
    </div>
  );
}

export default App;
