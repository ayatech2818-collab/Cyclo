import type { ButtonHTMLAttributes } from "react";

import { buttonClass, iconButtonClass, type ButtonSize, type ButtonVariant } from "./styles";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

/** Design-system button. For links styled as buttons use `buttonClass()` on the Link. */
export function Button({ variant = "primary", size = "md", className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

/** Icon-only button; `aria-label` is required so it has an accessible name. */
export function IconButton({ size = "md", className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: ButtonSize; "aria-label": string }) {
  return <button type={type} className={iconButtonClass(size, className)} {...props} />;
}
