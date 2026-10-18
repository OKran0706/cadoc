"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Search, Globe, Check, ChevronDown, X } from "lucide-react";
import { COUNTRIES, getCountryByCode, type Country } from "@/lib/countries";

interface SearchableCountrySelectProps {
  value: string;
  onChange: (countryCode: string) => void;
  onBlur?: () => void;
  hasError?: boolean;
  errorMessage?: string;
  placeholder?: string;
  disabled?: boolean;
}

type RegionFilter = "ALL" | "TOP" | "Americas" | "Europe" | "Asia Pacific" | "Middle East & Africa";

export function SearchableCountrySelect({
  value,
  onChange,
  onBlur,
  hasError,
  errorMessage,
  placeholder = "-- Select Deployment Country --",
  disabled = false,
}: SearchableCountrySelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeRegion, setActiveRegion] = useState<RegionFilter>("ALL");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedCountry = useMemo(() => getCountryByCode(value), [value]);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        if (isOpen) {
          setIsOpen(false);
          if (onBlur) onBlur();
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onBlur]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearch("");
      setActiveRegion("ALL");
    }
  }, [isOpen]);

  // Filtered countries based on search query and region filter
  const filteredCountries = useMemo(() => {
    let list = COUNTRIES;

    // Region filter
    if (activeRegion === "TOP") {
      list = COUNTRIES.slice(0, 12);
    } else if (activeRegion !== "ALL") {
      list = COUNTRIES.filter((c) => c.region === activeRegion);
    }

    // Search query filter (matches country name, ISO code, or region)
    const q = search.trim().toLowerCase();
    if (!q) return list;

    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.region.toLowerCase().includes(q)
    );
  }, [search, activeRegion]);

  const handleSelect = (code: string) => {
    onChange(code);
    setIsOpen(false);
    if (onBlur) onBlur();
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Hidden native select for accessibility and form integration */}
      <select
        value={value}
        onChange={(e) => handleSelect(e.target.value)}
        onBlur={onBlur}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only pointer-events-none"
      >
        <option value="">{placeholder}</option>
        <optgroup label="Top Datacenter & Cloud Regions">
          {COUNTRIES.slice(0, 12).map((c) => (
            <option key={`opt-top-${c.code}`} value={c.code}>
              {c.flag} {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
        <optgroup label="Americas">
          {COUNTRIES.filter((c) => c.region === "Americas").map((c) => (
            <option key={`opt-am-${c.code}`} value={c.code}>
              {c.flag} {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
        <optgroup label="Europe">
          {COUNTRIES.filter((c) => c.region === "Europe").map((c) => (
            <option key={`opt-eu-${c.code}`} value={c.code}>
              {c.flag} {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
        <optgroup label="Asia Pacific">
          {COUNTRIES.filter((c) => c.region === "Asia Pacific").map((c) => (
            <option key={`opt-ap-${c.code}`} value={c.code}>
              {c.flag} {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
        <optgroup label="Middle East & Africa">
          {COUNTRIES.filter((c) => c.region === "Middle East & Africa").map((c) => (
            <option key={`opt-mea-${c.code}`} value={c.code}>
              {c.flag} {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
      </select>

      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className={`w-full flex items-center justify-between bg-surface-container-low border rounded-xl px-3.5 py-2.5 text-sm transition-all cursor-pointer ${
          hasError
            ? "border-red-400 bg-red-50/20 text-on-surface focus:border-red-500"
            : isOpen
              ? "border-primary ring-2 ring-primary/10 text-on-surface bg-white"
              : "border-outline-variant/20 hover:border-primary/40 text-on-surface"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {selectedCountry ? (
            <>
              <span className="text-lg leading-none shrink-0">{selectedCountry.flag}</span>
              <span className="font-semibold text-on-surface truncate">{selectedCountry.name}</span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant shrink-0">
                {selectedCountry.code}
              </span>
            </>
          ) : (
            <>
              <Globe className="w-4 h-4 text-on-surface-variant/40 shrink-0" />
              <span className="text-on-surface-variant/50 text-sm truncate">{placeholder}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 ml-2 shrink-0">
          {selectedCountry && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSelect("");
              }}
              className="p-1 hover:bg-surface-container-high rounded-full text-on-surface-variant/60 hover:text-on-surface transition-colors"
              title="Clear selection"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <ChevronDown
            className={`w-4 h-4 text-on-surface-variant transition-transform duration-200 ${
              isOpen ? "rotate-180 text-primary" : ""
            }`}
          />
        </div>
      </button>

      {/* Popover Dropdown with Search & Filters */}
      {isOpen && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-white rounded-2xl shadow-xl border border-outline-variant/15 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          {/* Search Bar */}
          <div className="p-3 border-b border-outline-variant/10 bg-surface-container-low/40">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-on-surface-variant/50 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search country, code, or cloud region..."
                className="w-full bg-white border border-outline-variant/20 rounded-xl pl-9 pr-8 py-2 text-xs text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/50 transition-colors"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-on-surface-variant/40 hover:text-on-surface transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Region Filter Chips */}
            <div className="flex items-center gap-1 overflow-x-auto pt-2 pb-0.5 no-scrollbar">
              {(
                [
                  { id: "ALL", label: "All" },
                  { id: "TOP", label: "Top Cloud" },
                  { id: "Americas", label: "Americas" },
                  { id: "Europe", label: "Europe" },
                  { id: "Asia Pacific", label: "APAC" },
                  { id: "Middle East & Africa", label: "MEA" },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setActiveRegion(chip.id)}
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap transition-colors cursor-pointer ${
                    activeRegion === chip.id
                      ? "bg-primary text-white"
                      : "bg-surface-container-high/60 text-on-surface-variant hover:bg-surface-container-high"
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* Country Items List */}
          <div className="max-h-60 overflow-y-auto p-1.5 space-y-0.5">
            {filteredCountries.length === 0 ? (
              <div className="text-center py-6 px-4">
                <Globe className="w-6 h-6 text-on-surface-variant/30 mx-auto mb-1.5" />
                <p className="text-xs font-semibold text-on-surface-variant">No countries found</p>
                <p className="text-[10px] text-on-surface-variant/60">
                  Try searching with a different name, ISO code, or region
                </p>
              </div>
            ) : (
              filteredCountries.map((c) => {
                const isSelected = c.code === value;
                return (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => handleSelect(c.code)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-primary/10 text-primary font-bold border border-primary/20"
                        : "text-on-surface hover:bg-surface-container-high/70"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-base leading-none shrink-0">{c.flag}</span>
                      <span className="truncate">{c.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-container-high text-on-surface-variant">
                        {c.code}
                      </span>
                      <span className="text-[9px] text-on-surface-variant/60 font-normal">
                        {c.region}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
