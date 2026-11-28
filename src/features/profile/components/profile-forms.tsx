"use client";

import { useActionState, useState, type ReactNode } from "react";
import { ImageUp, Shapes, Smile, Trash2, Type, UserRound } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { cn } from "@/lib/utils/cn";

import { removeAvatarImageAction, selectAvatarAction, updateNameAction, uploadAvatarAction, type ProfileFormState } from "../actions";
import { AVATAR_MAX_BYTES, type AvatarKind } from "../avatar";
import { EMOJI_AVATAR_IDS, EMOJI_AVATARS, ICON_AVATAR_IDS, ICON_AVATARS } from "../avatar-catalog";
import { AVATAR_ICON_COMPONENTS } from "../avatar-icons";

const initial: ProfileFormState = { error: null, success: null };
const input = "mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm disabled:opacity-60";
const primaryButton = "inline-flex items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-action-hover disabled:opacity-60";
const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-60";

function Feedback({ state }: { state: ProfileFormState }) {
  return (
    <div aria-live="polite" className="min-h-5 text-sm">
      {state.error && <p role="alert" className="text-danger">{state.error}</p>}
      {state.success && <p role="status" className="text-success">{state.success}</p>}
    </div>
  );
}

export function ProfileNameForm({ fullName }: { fullName: string }) {
  const [state, action, pending] = useActionState(updateNameAction, initial);
  return (
    <form action={action} className="space-y-3" aria-busy={pending}>
      <label className="block text-sm font-medium">
        Full name
        <input name="fullName" required maxLength={200} defaultValue={fullName} autoComplete="name" disabled={pending} className={input} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className={primaryButton}>{pending ? "Saving…" : "Save name"}</button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

type Tab = "photo" | "emoji" | "icon" | "initials";

const tabs: { id: Tab; label: string; icon: typeof Smile }[] = [
  { id: "photo", label: "Photo", icon: ImageUp },
  { id: "emoji", label: "Emoji", icon: Smile },
  { id: "icon", label: "Icon", icon: Shapes },
  { id: "initials", label: "Initials", icon: Type },
];

function tabFor(kind: AvatarKind | undefined): Tab {
  if (kind === "image") return "photo";
  if (kind === "emoji" || kind === "icon") return kind;
  return "initials";
}

export type AvatarPickerProps = {
  fullName: string | null;
  email: string | null;
  kind: AvatarKind;
  symbol: string | null;
  photoSrc: string | null;
  hasPhoto: boolean;
  adminUrl: string | null;
};

/** One form per action; every choice submits an allowlisted identifier only. */
export function AvatarPicker({ fullName, email, kind, symbol, photoSrc, hasPhoto, adminUrl }: AvatarPickerProps) {
  const [tab, setTab] = useState<Tab>(tabFor(kind));
  const [select, selectAction, selecting] = useActionState(selectAvatarAction, initial);
  const [upload, uploadAction, uploading] = useActionState(uploadAvatarAction, initial);
  const [remove, removeAction, removing] = useActionState(removeAvatarImageAction, initial);
  const [fileError, setFileError] = useState<string | null>(null);
  const busy = selecting || uploading || removing;
  const [last, setLast] = useState<"select" | "upload" | "remove">("select");
  const latest = { select, upload, remove }[last];
  const onSelect = () => setLast("select");

  const choice = (value: string, selected: boolean, label: string, content: ReactNode) => (
    <button
      key={value}
      type="submit"
      name="symbol"
      value={value}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      disabled={busy}
      className={cn(
        "flex size-12 items-center justify-center rounded-lg border text-2xl transition-colors disabled:opacity-60",
        selected ? "border-primary bg-primary/10 ring-2 ring-primary/30" : "border-border hover:border-primary/50 hover:bg-surface-muted",
      )}
    >
      {content}
    </button>
  );

  return (
    <div className="space-y-5" aria-busy={busy}>
      <div role="tablist" aria-label="Avatar type" className="grid grid-cols-4 gap-1 rounded-lg bg-surface-muted p-1">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`avatar-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`avatar-panel-${id}`}
            aria-label={label}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium",
              tab === id ? "bg-surface text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {/* One label: visually hidden on phones, always the tab's accessible name. */}
            <span className="sr-only sm:not-sr-only">{label}</span>
          </button>
        ))}
      </div>

      {tab === "photo" && (
        <div role="tabpanel" id="avatar-panel-photo" aria-labelledby="avatar-tab-photo" className="space-y-4">
          {hasPhoto && (
            <div className="flex flex-wrap items-center gap-4">
              {photoSrc
                ? <EmployeeAvatar fullName={fullName} email={email} avatarUrl={null} avatar={{ type: "image", src: photoSrc }} size="lg" />
                : <span className="text-sm text-text-secondary">Your photo could not be loaded.</span>}
              <div className="flex flex-wrap gap-2">
                {kind !== "image" && (
                  <form action={selectAction} onSubmit={onSelect}>
                    <input type="hidden" name="kind" value="image" />
                    <button disabled={busy} className={primaryButton}>Use this photo</button>
                  </form>
                )}
                <form
                  action={removeAction}
                  onSubmit={(event) => { if (!window.confirm("Remove your uploaded photo?")) event.preventDefault(); else setLast("remove"); }}
                >
                  <button disabled={busy} className={cn(secondaryButton, "text-danger")}>
                    <Trash2 aria-hidden="true" className="size-4" />
                    {removing ? "Removing…" : "Remove photo"}
                  </button>
                </form>
              </div>
            </div>
          )}
          <form
            action={uploadAction}
            className="space-y-3"
            onSubmit={(event) => {
              const file = (event.currentTarget.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
              const error = !file ? "Choose an image to upload." : file.size > AVATAR_MAX_BYTES ? "The image must be 2 MB or smaller." : null;
              setFileError(error);
              if (error) event.preventDefault();
              else setLast("upload");
            }}
          >
            <label className="block text-sm font-medium">
              {hasPhoto ? "Replace photo" : "Upload a photo"}
              <input
                name="file"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                required
                disabled={busy}
                className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
              />
            </label>
            <p className="text-xs text-text-secondary">JPEG, PNG or WebP, up to 2 MB. Only administrators and project managers can see it besides you.</p>
            {fileError && <p role="alert" className="text-sm text-danger">{fileError}</p>}
            <button disabled={busy} className={primaryButton}>{uploading ? "Uploading…" : "Upload photo"}</button>
          </form>
        </div>
      )}

      {tab === "emoji" && (
        <form role="tabpanel" id="avatar-panel-emoji" aria-labelledby="avatar-tab-emoji" action={selectAction} onSubmit={onSelect}>
          <input type="hidden" name="kind" value="emoji" />
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
            {EMOJI_AVATAR_IDS.map((id) => choice(id, kind === "emoji" && symbol === id, EMOJI_AVATARS[id].label, <span aria-hidden="true">{EMOJI_AVATARS[id].char}</span>))}
          </div>
        </form>
      )}

      {tab === "icon" && (
        <form role="tabpanel" id="avatar-panel-icon" aria-labelledby="avatar-tab-icon" action={selectAction} onSubmit={onSelect}>
          <input type="hidden" name="kind" value="icon" />
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
            {ICON_AVATAR_IDS.map((id) => {
              const Icon = AVATAR_ICON_COMPONENTS[id];
              return choice(id, kind === "icon" && symbol === id, ICON_AVATARS[id], <Icon aria-hidden="true" className="size-5 text-primary" />);
            })}
          </div>
        </form>
      )}

      {tab === "initials" && (
        <div role="tabpanel" id="avatar-panel-initials" aria-labelledby="avatar-tab-initials" className="flex flex-wrap items-center gap-3">
          <EmployeeAvatar fullName={fullName} email={email} avatarUrl={null} avatar={{ type: "initials" }} size="lg" />
          <form action={selectAction} onSubmit={onSelect}>
            <input type="hidden" name="kind" value="initials" />
            <button disabled={busy || kind === "initials"} className={primaryButton}>
              {kind === "initials" ? "Using initials" : "Use initials"}
            </button>
          </form>
          {adminUrl && (
            <form action={selectAction} onSubmit={onSelect}>
              <input type="hidden" name="kind" value="default" />
              <button disabled={busy || kind === "default"} className={secondaryButton}>
                <UserRound aria-hidden="true" className="size-4" />
                {kind === "default" ? "Using administrator photo" : "Use administrator photo"}
              </button>
            </form>
          )}
        </div>
      )}

      <Feedback state={latest} />
    </div>
  );
}
