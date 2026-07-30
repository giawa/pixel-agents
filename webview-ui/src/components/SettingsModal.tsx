import { useRef, useState } from 'react';

import { CLIENT_SETTING_KEYS, setClientSetting } from '../clientSettings.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  hooksEnabled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
  /** True when the client is remote; all mutations are disabled. */
  readOnly?: boolean;
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksEnabled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
  readOnly,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      {readOnly && (
        <div className="mx-10 mt-6 mb-2 py-2 px-4 bg-warning/10 border-2 border-warning text-warning text-xs text-center">
          View-only mode — connect from localhost to make changes
        </div>
      )}
      {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={
            readOnly
              ? undefined
              : () => {
                  transport.send({ type: 'openSessionsFolder' });
                  onClose();
                }
          }
          disabled={readOnly}
        >
          Open Sessions Folder
        </MenuItem>
      )}
      <MenuItem
        onClick={
          readOnly
            ? undefined
            : () => {
                if (isBrowserRuntime) {
                  onExportLayout();
                } else {
                  transport.send({ type: 'exportLayout' });
                }
                onClose();
              }
        }
        disabled={readOnly}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={
          readOnly
            ? undefined
            : () => {
                if (isBrowserRuntime) {
                  // Open the native file picker; the import is applied in onChange below.
                  fileInputRef.current?.click();
                } else {
                  transport.send({ type: 'importLayout' });
                  onClose();
                }
              }
        }
        disabled={readOnly}
      >
        Import Layout
      </MenuItem>
      {isBrowserRuntime && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          disabled={readOnly}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the value so re-selecting the same file fires change again.
            e.target.value = '';
            if (file) {
              onImportLayout(file);
              onClose();
            }
          }}
        />
      )}
      {/* Browser has no native directory picker, so accept a typed absolute path. */}
      {isBrowserRuntime ? (
        <div className="flex items-center gap-4 py-4 px-10">
          <input
            type="text"
            value={assetDirDraft}
            placeholder="Absolute asset directory path"
            disabled={readOnly}
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text disabled:opacity-50 disabled:cursor-default"
          />
          <Button
            variant={readOnly ? 'disabled' : 'default'}
            size="sm"
            onClick={
              readOnly
                ? undefined
                : () => {
                    const path = assetDirDraft.trim();
                    if (!path) return;
                    transport.send({ type: 'addExternalAssetDirectory', path });
                    setAssetDirDraft('');
                  }
            }
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={
            readOnly
              ? undefined
              : () => {
                  transport.send({ type: 'addExternalAssetDirectory' });
                  onClose();
                }
          }
          disabled={readOnly}
        >
          Add Asset Directory
        </MenuItem>
      )}
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant={readOnly ? 'disabled' : 'ghost'}
            size="sm"
            onClick={
              readOnly
                ? undefined
                : () => transport.send({ type: 'removeExternalAssetDirectory', path: dir })
            }
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          if (readOnly) {
            setClientSetting(CLIENT_SETTING_KEYS.SOUND_ENABLED, newVal);
          } else {
            transport.send({ type: 'setSoundEnabled', enabled: newVal });
          }
        }}
      />
      <Checkbox
        label="Watch All Sessions"
        checked={watchAllSessions}
        disabled={readOnly}
        onChange={onToggleWatchAllSessions}
      />
      <Checkbox
        label="Instant Detection (Hooks)"
        checked={hooksEnabled}
        disabled={readOnly}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      {showAreasAvailable && (
        <Checkbox label="Show Areas" checked={showAreas} onChange={onToggleShowAreas} />
      )}
      <Checkbox
        label="Debug View"
        checked={isDebugMode}
        disabled={readOnly}
        onChange={onToggleDebugMode}
      />
    </Modal>
  );
}
