import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-semibold whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-red-600/25 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Red background + white text: the main action on a screen, emergency submission.
        default: "bg-red-600 text-white shadow-card hover:bg-red-700",
        // White background + border: secondary actions.
        secondary: "border border-grey-300 bg-white text-grey-900 shadow-card hover:border-grey-500 hover:bg-grey-25",
        // White background + red border: secondary action that belongs to the brand (e.g. "For Hospitals").
        outline: "border border-red-600 bg-white text-red-600 hover:bg-red-50",
        // Reject / cancel style destructive action that is not itself an emergency.
        destructive: "border border-grey-300 bg-white text-status-critical hover:border-status-critical hover:bg-red-50",
        ghost: "text-grey-600 hover:bg-grey-50 hover:text-grey-900",
        link: "px-0 text-red-600 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-[13px]",
        lg: "h-11 px-5 text-[15px]",
        icon: "size-10",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
