/**
 * RFC 4180 Compliant CSV Export Utility
 * Handles proper double-quote escaping, newlines, and UTF-8 BOM for Excel compatibility.
 */

/**
 * Escapes a single CSV field value according to RFC 4180 rules.
 * If value contains quotes, commas, or line breaks, wraps in quotes and doubles inner quotes.
 */
export function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) {
    return '""';
  }
  const stringValue = String(value);
  // Double internal double-quotes according to RFC 4180
  return `"${stringValue.replace(/"/g, '""')}"`;
}

/**
 * Generates an RFC 4180 compliant CSV string from an array of headers and rows.
 */
export function generateCSV(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][]
): string {
  const headerLine = headers.map(escapeCSVField).join(",");
  const dataLines = rows.map((row) => row.map(escapeCSVField).join(","));
  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * Triggers a file download of the given CSV string in the browser.
 * - Prepends UTF-8 BOM (\uFEFF) for Microsoft Excel compatibility
 * - Appends link to document.body prior to click for cross-browser reliability
 * - Defers URL.revokeObjectURL asynchronously so download completes without cancellation
 */
export function downloadCSV(filename: string, csvContent: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const cleanFilename = filename.toLowerCase().endsWith(".csv")
      ? filename
      : `${filename}.csv`;

    const bomContent = "\uFEFF" + csvContent;

    // Check for msSaveOrOpenBlob
    if (typeof (window.navigator as any)?.msSaveOrOpenBlob === "function") {
      const blob = new Blob([bomContent], { type: "text/csv;charset=utf-8;" });
      (window.navigator as any).msSaveOrOpenBlob(blob, cleanFilename);
      return true;
    }

    // Modern browsers: Blob object URL
    try {
      const blob = new Blob([bomContent], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", cleanFilename);
      link.style.display = "none";

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 2000);
      return true;
    } catch {
      // Data URI fallback
      const encodedUri = "data:text/csv;charset=utf-8," + encodeURIComponent(bomContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", cleanFilename);
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return true;
    }
  } catch (error) {
    console.error("Error executing CSV download:", error);
    return false;
  }
}
