import { useState, useEffect, useRef } from "react";

/**
 * A custom hook that creates a typewriter effect using requestAnimationFrame.
 */
export function useTypewriter(text: string, speed: number = 30, enabled: boolean = true) {
  const [displayText, setDisplayText] = useState("");
  const displayTextRef = useRef("");
  const pendingTextRef = useRef("");
  const lastUpdateRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const [isFinished, setIsFinished] = useState(false);

  useEffect(() => {
    displayTextRef.current = displayText;
  }, [displayText]);

  useEffect(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    lastUpdateRef.current = 0;

    if (!enabled) {
      pendingTextRef.current = "";
      setDisplayText(text);
      displayTextRef.current = text;
      setIsFinished(true);
      return;
    }

    const currentDisplayText = displayTextRef.current;

    if (!text.startsWith(currentDisplayText)) {
      pendingTextRef.current = text;
      setDisplayText("");
      displayTextRef.current = "";
      setIsFinished(false);
    } else {
      pendingTextRef.current = text.slice(currentDisplayText.length);
      if (pendingTextRef.current.length > 0) {
        setIsFinished(false);
      }
    }

    const animate = (time: number) => {
      if (lastUpdateRef.current === 0) {
        lastUpdateRef.current = time;
      }

      const elapsed = time - lastUpdateRef.current;

      if (elapsed >= speed) {
        const nextChunk = pendingTextRef.current.slice(0, 1);

        if (nextChunk.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(1);
          const nextDisplayText = displayTextRef.current + nextChunk;
          displayTextRef.current = nextDisplayText;
          setDisplayText(nextDisplayText);
          lastUpdateRef.current = time;
          setIsFinished(false);

          if (pendingTextRef.current.length === 0) {
            setIsFinished(true);
          }
        } else {
          setIsFinished(true);
        }
      }

      if (pendingTextRef.current.length > 0) {
        rafIdRef.current = requestAnimationFrame(animate);
      }
    };

    if (pendingTextRef.current.length > 0) {
      rafIdRef.current = requestAnimationFrame(animate);
    } else {
      setIsFinished(true);
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [text, speed, enabled]);

  return { displayText, isFinished };
}
