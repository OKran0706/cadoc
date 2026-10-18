"use client";

import React from "react";
import US from "country-flag-icons/string/3x2/US";
import DE from "country-flag-icons/string/3x2/DE";
import IN from "country-flag-icons/string/3x2/IN";
import GB from "country-flag-icons/string/3x2/GB";
import JP from "country-flag-icons/string/3x2/JP";
import BR from "country-flag-icons/string/3x2/BR";
import RU from "country-flag-icons/string/3x2/RU";
import RO from "country-flag-icons/string/3x2/RO";
import FR from "country-flag-icons/string/3x2/FR";
import CN from "country-flag-icons/string/3x2/CN";
import CA from "country-flag-icons/string/3x2/CA";
import AU from "country-flag-icons/string/3x2/AU";

const FLAG_MAP: Record<string, string> = {
  US,
  DE,
  IN,
  GB,
  JP,
  BR,
  RU,
  RO,
  FR,
  CN,
  CA,
  AU,
};

interface CountryFlagProps {
  code?: string;
  className?: string;
  title?: string;
}

export function CountryFlag({ code = "UN", className = "w-4 h-3 inline-block", title }: CountryFlagProps) {
  const upper = code.toUpperCase();
  const svgString = FLAG_MAP[upper];

  if (!svgString) {
    return (
      <span
        title={title || code}
        className={`inline-flex items-center justify-center font-mono text-[9px] bg-white/10 rounded px-1 text-white/70 ${className}`}
      >
        {upper}
      </span>
    );
  }

  return (
    <span
      title={title || code}
      className={`inline-block overflow-hidden rounded-[2px] shadow-sm shrink-0 align-middle ${className}`}
      dangerouslySetInnerHTML={{ __html: svgString }}
    />
  );
}
