import { useState, useEffect, useRef } from "react";

/**
 * A custom hook that creates a typewriter effect using requestAnimationFrame.
 * 
 * @param text The target text to display.
 * @param speed The speed of typing in milliseconds per character.
 * @param enabled Whether the typewriter effect is enabled.
 * @returns The currently displayed text.
 */
export function useTypewriter(text: string, speed: number = 30, enabled: boolean = true) {
  const [displayText, setDisplayText] = useState("");
  const currentIndexRef = useRef(0);
  const lastUpdateRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const [isFinished, setIsFinished] = useState(false);

  useEffect(() => {
    // If disabled, just show the whole text immediately
    if (!enabled) {
      setDisplayText(text);
      currentIndexRef.current = text.length;
      setIsFinished(true);
      return;
    }

    // Reset if text is shorter than current (new message or reset)
    if (text.length < currentIndexRef.current) {
      currentIndexRef.current = 0;
      setDisplayText("");
      setIsFinished(false);
    } else if (text.length > currentIndexRef.current) {
      setIsFinished(false);
    }

    const animate = (time: number) => {
      if (lastUpdateRef.current === 0) {
        lastUpdateRef.current = time;
      }

      const elapsed = time - lastUpdateRef.current;

      if (elapsed >= speed) {
        if (currentIndexRef.current < text.length) {
          // Increment the index and update the display text
          currentIndexRef.current += 1;
          setDisplayText(text.slice(0, currentIndexRef.current));
          // Reset lastUpdateRef to current time for next character
          lastUpdateRef.current = time;
          setIsFinished(false);
        } else {
          setIsFinished(true);
        }
      }

      // Continue animation as long as there's text left to type
      if (currentIndexRef.current < text.length) {
        rafIdRef.current = requestAnimationFrame(animate);
      }
    };

    // Start or restart animation
    rafIdRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [text, speed, enabled]);

  return { displayText, isFinished };
}
