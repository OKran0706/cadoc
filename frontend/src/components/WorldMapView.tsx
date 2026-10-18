"use client";

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// OpenFreeMap Dark Style
const OPENFREEMAP_DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";

if (typeof window !== "undefined") {
  try {
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  } catch (err) {
    console.warn("Worker URL registration warning:", err);
  }
}

import * as turf from "@turf/turf";
import {
  TopologyNode,
  SECURITY_COMMAND_CENTER,
  ARCHITECTURAL_DATA_FLOWS,
  Facility,
} from "@/lib/holisticData";
import { hasActiveIncident } from "@/lib/incidentExplainer";
import { CountryFlag } from "./CountryFlag";
import { createGreatCircleArc } from "@/lib/geoUtils";
import {
  ArrowLeft, AlertTriangle, Flame, ChevronRight, ShieldCheck
} from "lucide-react";

interface WorldMapViewProps {
  nodes: TopologyNode[];
  selectedNodeId: string | null;
  onSelectNode: (node: TopologyNode | null) => void;
  onIsolateNode?: (node: TopologyNode) => void;
  onOpenBrief?: (nodeId: string) => void;
  autoFollowIncidents?: boolean;
}

type ZoomLevel = "world" | "country" | "city" | "facility";

export function WorldMapView({
  nodes,
  selectedNodeId,
  onSelectNode,
  onOpenBrief,
  autoFollowIncidents = true,
}: WorldMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // Navigation and Level State
  const [currentLevel, setCurrentLevel] = useState<ZoomLevel>("world");
  const [activeCountry, setActiveCountry] = useState<string | null>(null);
  const [activeCity, setActiveCity] = useState<string | null>(null);
  const [activeFacility, setActiveFacility] = useState<Facility | null>(null);
  const [activeFloorLevel, setActiveFloorLevel] = useState<number | null>(null);
  const [activeRack, setActiveRack] = useState<string | null>(null);

  // Performance and Layer Toggles
  const [performanceMode, setPerformanceMode] = useState<boolean>(false);
  const [layerCountries, setLayerCountries] = useState(true);
  const [layerTelemetry, setLayerTelemetry] = useState(true);
  const [layerDataFlows, setLayerDataFlows] = useState(true);
  const [basemapOfflineNotice, setBasemapOfflineNotice] = useState(false);

  // Auto-rotate state
  const isInteractingRef = useRef(false);
  const idleTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Group nodes by facility
  const facilitiesMap = useMemo(() => {
    const map = new Map<string, { facility: Facility; nodes: TopologyNode[]; lat: number; lng: number; city: string; country: string; countryCode: string }>();
    nodes.forEach((node) => {
      const facId = node.facility.id;
      if (!map.has(facId)) {
        map.set(facId, {
          facility: node.facility,
          nodes: [],
          lat: node.geo.lat,
          lng: node.geo.lng,
          city: node.geo.city,
          country: node.geo.country,
          countryCode: node.geo.countryCode,
        });
      }
      map.get(facId)!.nodes.push(node);
    });
    return map;
  }, [nodes]);

  // Group nodes by country for status tinting
  const countryStatusMap = useMemo(() => {
    const map: Record<string, { worstStatus: "healthy" | "warning" | "tampered"; nodeCount: number; incidentCount: number }> = {};
    nodes.forEach((n) => {
      const c = n.geo.country;
      if (!map[c]) {
        map[c] = { worstStatus: "healthy", nodeCount: 0, incidentCount: 0 };
      }
      map[c].nodeCount += 1;
      if (n.tampered) {
        map[c].worstStatus = "tampered";
        map[c].incidentCount += 1;
      } else if (n.status === "warning" && map[c].worstStatus !== "tampered") {
        map[c].worstStatus = "warning";
      }
    });
    return map;
  }, [nodes]);

  // Active Incidents list for left panel
  const activeIncidents = useMemo(() => {
    return nodes.filter(hasActiveIncident);
  }, [nodes]);

  // Check prefers-reduced-motion on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (mediaQuery.matches) {
        setPerformanceMode(true);
      }
    }
  }, []);

  // Initialize MapLibre with OpenFreeMap Dark Style
  useEffect(() => {
    if (!mapContainerRef.current) return;

    let styleLoaded = false;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OPENFREEMAP_DARK_STYLE,
      center: [15, 25],
      zoom: 1.8,
      pitch: 0,
      bearing: 0,
      // @ts-ignore
      antialias: true,
      fadeDuration: 0,
    });

    mapRef.current = map;

    // Detect fatal basemap errors (e.g. style fails to download entirely)
    map.on("error", (e) => {
      if (!styleLoaded && (e.error?.message?.includes("style") || (e as any).status === 404)) {
        console.warn("OpenFreeMap style download issue, showing telemetry fallback notice:", e.error?.message || e);
        setBasemapOfflineNotice(true);
      }
    });

    // Detect user interactions to pause auto-rotation
    const handleStartInteract = () => {
      isInteractingRef.current = true;
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = setTimeout(() => {
        isInteractingRef.current = false;
      }, 5000);
    };

    map.on("movestart", handleStartInteract);
    map.on("rotatestart", handleStartInteract);
    map.on("pitchstart", handleStartInteract);
    map.on("wheel", handleStartInteract);

    // Track zoom level for breadcrumbs
    map.on("zoom", () => {
      const z = map.getZoom();
      if (z < 4) {
        setCurrentLevel("world");
        setActiveFloorLevel(null);
      } else if (z < 13) {
        setCurrentLevel("country");
        setActiveFloorLevel(null);
      } else if (z < 16.5) {
        setCurrentLevel("city");
        setActiveFloorLevel(null);
      } else {
        setCurrentLevel("facility");
      }
    });

    map.on("load", () => {
      styleLoaded = true;
      setBasemapOfflineNotice(false);

      // 1. Cyber Atmosphere Fog
      try {
        // @ts-ignore
        map.setFog({
          color: "#060b13",
          "high-color": "#0ea5e9",
          "space-color": "#030712",
          "horizon-blend": 0.08,
          "star-intensity": 0.7,
        });
      } catch {
        // Fog not supported on flat projections
      }

      // 2. Add local countries GeoJSON overlay for organizational health highlights
      fetch("/geo/countries-50m.json")
        .then((r) => r.json())
        .then((countriesGeoJson) => {
          if (!map.getSource("countries-source")) {
            map.addSource("countries-source", {
              type: "geojson",
              data: countriesGeoJson,
            });

            // Dynamic country tinting layer for our organizational presence
            map.addLayer({
              id: "countries-org-tint",
              type: "fill",
              source: "countries-source",
              maxzoom: 7,
              filter: [
                "in",
                ["get", "name"],
                ["literal", Object.keys(countryStatusMap)],
              ],
              paint: {
                "fill-color": [
                  "match",
                  ["get", "name"],
                  "United States of America", "#ef4444",
                  "United Kingdom", "#ef4444",
                  "Germany", "#10b981",
                  "India", "#f59e0b",
                  "Japan", "#10b981",
                  "Brazil", "#10b981",
                  "#0a1120",
                ],
                "fill-opacity": 0.3,
              },
            });

            // Glowing boundary for tampered countries
            map.addLayer({
              id: "countries-tampered-glow",
              type: "line",
              source: "countries-source",
              maxzoom: 7,
              filter: [
                "in",
                ["get", "name"],
                ["literal", ["United States of America", "United Kingdom"]],
              ],
              paint: {
                "line-color": "#ef4444",
                "line-width": 2,
                "line-opacity": 0.8,
              },
            });
          }
        })
        .catch((err) => console.warn("Local countries overlay notice:", err));

      // 3. Basemap 3D Extruded Buildings (from OpenFreeMap's openmaptiles vector source)
      try {
        if (!map.getLayer("3d-buildings") && map.getSource("openmaptiles")) {
          map.addLayer({
            id: "3d-buildings",
            source: "openmaptiles",
            "source-layer": "building",
            type: "fill-extrusion",
            minzoom: 14,
            paint: {
              "fill-extrusion-color": "#1e293b",
              "fill-extrusion-height": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                0,
                14.5,
                ["coalesce", ["get", "render_height"], 12],
              ],
              "fill-extrusion-base": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                0,
                14.5,
                ["coalesce", ["get", "render_min_height"], 0],
              ],
              "fill-extrusion-opacity": 0.6,
            },
          });
        }
      } catch (err) {
        console.warn("3D buildings layer notice:", err);
      }

      // 4. Telemetry Great-Circle Arcs & Flows GeoJSON Source
      const arcFeatures: any[] = [];

      // Arcs from each facility to Sentinel Command (Mumbai)
      facilitiesMap.forEach((fac) => {
        if (fac.city !== SECURITY_COMMAND_CENTER.city) {
          const arcCoords = createGreatCircleArc(
            [fac.lng, fac.lat],
            [SECURITY_COMMAND_CENTER.lng, SECURITY_COMMAND_CENTER.lat],
            45
          );
          const hasTampered = fac.nodes.some((n) => n.tampered);
          arcFeatures.push({
            type: "Feature",
            properties: {
              type: "telemetry",
              fromCity: fac.city,
              toCity: SECURITY_COMMAND_CENTER.city,
              tampered: hasTampered,
              status: hasTampered ? "tampered" : "healthy",
            },
            geometry: {
              type: "LineString",
              coordinates: arcCoords,
            },
          });
        }
      });

      // Cross-facility data flows
      ARCHITECTURAL_DATA_FLOWS.forEach((flow) => {
        const fromFac = facilitiesMap.get(flow.fromFacility);
        const toFac = facilitiesMap.get(flow.toFacility);
        if (fromFac && toFac) {
          const flowCoords = createGreatCircleArc(
            [fromFac.lng, fromFac.lat],
            [toFac.lng, toFac.lat],
            35
          );
          arcFeatures.push({
            type: "Feature",
            properties: {
              type: "dataflow",
              label: flow.label,
              tampered: false,
              status: "dataflow",
            },
            geometry: {
              type: "LineString",
              coordinates: flowCoords,
            },
          });
        }
      });

      if (!map.getSource("arcs-source")) {
        map.addSource("arcs-source", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: arcFeatures,
          },
        });

        // Telemetry Arcs Layer
        map.addLayer({
          id: "telemetry-arcs-line",
          type: "line",
          source: "arcs-source",
          filter: ["==", ["get", "type"], "telemetry"],
          paint: {
            "line-color": [
              "case",
              ["==", ["get", "tampered"], true],
              "#ef4444",
              "#38bdf8",
            ],
            "line-width": 2,
            "line-opacity": 0.85,
          },
        });

        // Data-Flows Dashed Layer
        map.addLayer({
          id: "data-flows-line",
          type: "line",
          source: "arcs-source",
          filter: ["==", ["get", "type"], "dataflow"],
          paint: {
            "line-color": "#10b981",
            "line-width": 1.5,
            "line-dasharray": [3, 2],
            "line-opacity": 0.65,
          },
        });
      }

      // 5. Facility 3D Extruded Building Plots & Floor Slabs Cutaway Source
      const buildingFeatures: any[] = [];

      facilitiesMap.forEach((fac) => {
        const pt = turf.point([fac.lng, fac.lat]);
        const isTampered = fac.nodes.some((n) => n.tampered);
        const baseColor = isTampered ? "#ef4444" : "#0284c7";

        // Generate building footprint polygon
        const sizeKm = fac.facility.type === "hq" ? 0.05 : 0.04;
        const bbox = turf.bbox(turf.buffer(pt, sizeKm, { units: "kilometers" }) as any);
        const poly = turf.bboxPolygon(bbox);

        // Exploded Floor Slabs (Levels 1 to 5)
        fac.facility.floors.forEach((floor) => {
          const floorTampered = fac.nodes.some(
            (n) => n.tampered && n.placement.floor === floor.level
          );
          const slabBase = (floor.level - 1) * 7;
          const slabHeight = slabBase + 4.5;

          buildingFeatures.push({
            type: "Feature",
            properties: {
              facilityId: fac.facility.id,
              facilityName: fac.facility.name,
              floorLevel: floor.level,
              floorLabel: floor.label,
              isTampered: floorTampered,
              base: slabBase,
              height: slabHeight,
              color: floorTampered ? "#ef4444" : baseColor,
            },
            geometry: poly.geometry,
          });

          // Small rack blocks inside this floor
          const floorNodes = fac.nodes.filter((n) => n.placement.floor === floor.level);
          floorNodes.forEach((node, nodeIdx) => {
            const rackOffset = (nodeIdx - 0.5) * 0.012;
            const rackPt = turf.point([fac.lng + rackOffset, fac.lat + rackOffset]);
            const rackBbox = turf.bbox(turf.buffer(rackPt, 0.008, { units: "kilometers" }) as any);
            const rackPoly = turf.bboxPolygon(rackBbox);

            buildingFeatures.push({
              type: "Feature",
              properties: {
                facilityId: fac.facility.id,
                nodeId: node.id,
                nodeName: node.name,
                isRack: true,
                isTampered: node.tampered,
                base: slabBase + 0.2,
                height: slabBase + 3.8,
                color: node.tampered ? "#f87171" : "#38bdf8",
              },
              geometry: rackPoly.geometry,
            });
          });
        });
      });

      if (!map.getSource("facility-slabs-source")) {
        map.addSource("facility-slabs-source", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: buildingFeatures,
          },
        });

        // 3D Extruded Floor Slabs & Racks
        map.addLayer({
          id: "facility-3d-slabs",
          type: "fill-extrusion",
          source: "facility-slabs-source",
          minzoom: 14.5,
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-opacity": [
              "case",
              ["==", ["get", "isRack"], true],
              0.95,
              0.55,
            ],
          },
        });
      }

      // 6. Click handler on 3D slabs or racks
      map.on("click", "facility-3d-slabs", (e) => {
        if (e.features && e.features[0]) {
          const props = e.features[0].properties;
          if (props?.nodeId) {
            const targetNode = nodes.find((n) => n.id === props.nodeId);
            if (targetNode) {
              onSelectNode(targetNode);
            }
          }
        }
      });
    });

    // 7. Slow Idle Auto-Rotation Loop
    let lastTime = performance.now();
    const rotateGlobe = (time: number) => {
      animationFrameRef.current = requestAnimationFrame(rotateGlobe);
      const delta = time - lastTime;
      lastTime = time;

      if (!isInteractingRef.current && !performanceMode && mapRef.current) {
        const currentZoom = mapRef.current.getZoom();
        if (currentZoom < 3) {
          const currentBearing = mapRef.current.getBearing();
          mapRef.current.setBearing(currentBearing + 0.05);
        }
      }
    };
    animationFrameRef.current = requestAnimationFrame(rotateGlobe);

    // Cleanup
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
      }
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [facilitiesMap, countryStatusMap, performanceMode, onSelectNode, nodes]);

  // Synchronize dynamic facility HTML Markers (Shockwaves, Hub Halos, Beacons)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    facilitiesMap.forEach((fac) => {
      const isSelected = fac.nodes.some((n) => n.id === selectedNodeId);
      const isTampered = fac.nodes.some((n) => n.tampered);
      const el = document.createElement("div");
      el.className = "relative cursor-pointer group";
      el.dataset.selected = String(isSelected);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", "Inspect facility in " + fac.city);
      if (isSelected) el.style.outline = "2px solid #a6ccdf";
      el.style.outlineOffset = "8px";
      el.style.borderRadius = "50%";

      // HTML template for pulsing facility hub
      el.innerHTML = `
        <div class="relative flex items-center justify-center">
          ${
            isTampered && !performanceMode
              ? `<span class="absolute w-12 h-12 rounded-full bg-red-500/30 animate-ping"></span>
                 <span class="absolute w-8 h-8 rounded-full border-2 border-red-500 animate-pulse"></span>`
              : `<span class="absolute w-6 h-6 rounded-full bg-cyan-500/20"></span>`
          }
          <div class="relative w-4 h-4 rounded-full flex items-center justify-center shadow-lg ${
            isTampered ? "bg-red-500 text-white" : "bg-cyan-500 text-white"
          }">
            <div class="w-2 h-2 rounded-full bg-white"></div>
          </div>
          ${
            isTampered
              ? `<div class="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap bg-red-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full shadow-lg border border-white/20 animate-bounce">
                  🚨 TAMPERING: ${fac.city}
                 </div>`
              : `<div class="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap bg-[#0a1120]/90 text-white text-[9px] font-bold px-2 py-0.5 rounded-full shadow-md border border-white/10 opacity-80 group-hover:opacity-100">
                  ${fac.city}
                 </div>`
          }
        </div>
      `;

      el.addEventListener("click", () => {
        flyToFacility(fac);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          flyToFacility(fac);
        }
      });

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([fac.lng, fac.lat])
        .addTo(map);

      markersRef.current.push(marker);
    });
  }, [facilitiesMap, performanceMode, selectedNodeId]);

  // Fly-to cinematic helper (Globe -> City -> Building)
  const flyToFacility = useCallback(
    (fac: { facility: Facility; nodes: TopologyNode[]; lat: number; lng: number; city: string; country: string; countryCode: string }) => {
      const map = mapRef.current;
      if (!map) return;

      setActiveCountry(fac.country);
      setActiveCity(fac.city);
      setActiveFacility(fac.facility);

      const targetTamperedNode = fac.nodes.find((n) => n.tampered);
      if (targetTamperedNode) {
        onSelectNode(targetTamperedNode);
        setActiveFloorLevel(targetTamperedNode.placement.floor);
        setActiveRack(targetTamperedNode.placement.rack);
      } else if (fac.nodes.length > 0) {
        onSelectNode(fac.nodes[0]);
      }

      // Fly to City / Building level
      map.flyTo({
        center: [fac.lng, fac.lat],
        zoom: 17,
        pitch: 62,
        bearing: 25,
        speed: 1.1,
        curve: 1.4,
        essential: true,
      });
    },
    [onSelectNode]
  );

  // Auto-follow incidents if toggled
  useEffect(() => {
    if (!autoFollowIncidents || activeIncidents.length === 0) return;
    const latestTampered = activeIncidents[0];
    const facData = facilitiesMap.get(latestTampered.facility.id);
    if (facData && mapRef.current) {
      if (activeFacility?.id !== latestTampered.facility.id) {
        flyToFacility(facData);
      }
    }
  }, [activeIncidents, autoFollowIncidents, facilitiesMap, activeFacility, flyToFacility]);

  // Selection from a brief follows the exact peer
  useEffect(() => {
    const node = nodes.find((n) => n.id === selectedNodeId);
    const map = mapRef.current;
    if (!node || !map) return;
    const focus = () => map.easeTo({ center: [node.geo.lng, node.geo.lat], zoom: 4, duration: 250 });
    if (map.loaded()) focus();
    else map.once("load", focus);
    return () => {
      map.off("load", focus);
    };
  }, [nodes, selectedNodeId]);

  // Back button handler
  const handleBackNavigation = () => {
    const map = mapRef.current;
    if (!map) return;

    if (currentLevel === "facility" || currentLevel === "city") {
      map.flyTo({
        center: map.getCenter(),
        zoom: 3.5,
        pitch: 15,
        bearing: 0,
        speed: 1.2,
      });
      setCurrentLevel("world");
      setActiveFacility(null);
      setActiveFloorLevel(null);
      setActiveRack(null);
    } else {
      map.flyTo({
        center: [15, 25],
        zoom: 1.8,
        pitch: 0,
        bearing: 0,
        speed: 1.2,
      });
      setCurrentLevel("world");
      setActiveCountry(null);
      setActiveCity(null);
      setActiveFacility(null);
    }
  };

  return (
    <div className="relative w-full h-[660px] bg-[#060b13] rounded-2xl overflow-hidden border border-slate-800 shadow-2xl select-none">
      {/* MapLibre WebGL Canvas Container with OpenFreeMap */}
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Top Breadcrumbs & Back Navigation Bar */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 flex-wrap">
        <button
          onClick={handleBackNavigation}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-[#0a1120]/85 hover:bg-[#0a1120] text-white backdrop-blur-md border border-white/10 shadow-lg transition-all"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back</span>
        </button>

        <div className="flex items-center gap-1.5 bg-[#0a1120]/85 backdrop-blur-md px-3.5 py-1.5 rounded-full border border-white/10 text-xs font-mono text-white shadow-lg">
          <span
            onClick={() => {
              mapRef.current?.flyTo({ center: [15, 25], zoom: 1.8, pitch: 0 });
              setCurrentLevel("world");
            }}
            className="cursor-pointer hover:text-cyan-400 transition-colors font-bold"
          >
            World
          </span>
          {activeCountry && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-400" />
              <span className="text-white font-medium">{activeCountry}</span>
            </>
          )}
          {activeCity && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-400" />
              <span className="text-cyan-300 font-medium">{activeCity}</span>
            </>
          )}
          {activeFacility && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-400" />
              <span className="text-white font-bold">{activeFacility.name}</span>
            </>
          )}
          {activeFloorLevel && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-400" />
              <span className="text-red-400 font-bold">Floor {activeFloorLevel}</span>
            </>
          )}
          {activeRack && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-400" />
              <span className="text-amber-400 font-bold">{activeRack}</span>
            </>
          )}
        </div>
      </div>

      {/* Left Panel: Active Incidents List with Cinematic Fly-To */}
      <div className="absolute top-16 left-4 z-20 w-72 max-w-[calc(100%-2rem)] bg-[#0a1120]/90 backdrop-blur-md border border-white/10 rounded-xl p-3.5 text-white shadow-2xl">
        <div className="flex items-center justify-between pb-2 border-b border-white/10 mb-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-red-400">
            <Flame className="w-4 h-4 animate-bounce" />
            <span>Active Incidents ({activeIncidents.length})</span>
          </div>
          <span className="text-[9px] font-mono text-slate-400">Live Mesh</span>
        </div>

        {activeIncidents.length === 0 ? (
          <div className="text-center py-4 text-xs text-emerald-400 font-medium">
            <ShieldCheck className="w-5 h-5 mx-auto mb-1 text-emerald-500" />
            All nodes nominal across all global facilities.
          </div>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {activeIncidents.map((inc) => (
              <div
                key={inc.id}
                data-testid={"incident-row-" + inc.id}
                className={`p-2 rounded-md border ${
                  selectedNodeId === inc.id ? "bg-slate-800 border-slate-400" : "bg-white/5 border-white/15"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => onSelectNode(inc)}
                    aria-label={"Inspect " + inc.name}
                    className="min-w-0 flex-1 text-left text-xs font-medium truncate focus-visible:outline-2"
                  >
                    <CountryFlag code={inc.geo.countryCode} className="w-3 h-2 inline mr-2" />
                    {inc.name}
                  </button>
                  <button
                    onClick={() => onOpenBrief?.(inc.id)}
                    className="px-2 py-1 rounded border border-slate-500 text-[10px] text-slate-200 hover:bg-slate-700 focus-visible:outline-2"
                    aria-label={`Open AI brief for ${inc.name}`}
                  >
                    Brief ↗
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-slate-400">
                  {inc.geo.city} • {inc.incident?.alertType?.replaceAll("_", " ") ?? "Active alert"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top Right: Layer Toggles & Performance Mode */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <div className="flex items-center gap-2 bg-[#0a1120]/85 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 text-[11px] font-medium text-white shadow-lg">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={layerCountries}
              onChange={(e) => {
                setLayerCountries(e.target.checked);
                if (mapRef.current) {
                  const visibility = e.target.checked ? "visible" : "none";
                  if (mapRef.current.getLayer("countries-org-tint")) {
                    mapRef.current.setLayoutProperty("countries-org-tint", "visibility", visibility);
                  }
                }
              }}
              className="accent-cyan-400 rounded"
            />
            <span>Countries</span>
          </label>

          <span className="text-white/20">|</span>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={layerTelemetry}
              onChange={(e) => {
                setLayerTelemetry(e.target.checked);
                if (mapRef.current) {
                  const visibility = e.target.checked ? "visible" : "none";
                  if (mapRef.current.getLayer("telemetry-arcs-line")) {
                    mapRef.current.setLayoutProperty("telemetry-arcs-line", "visibility", visibility);
                  }
                }
              }}
              className="accent-cyan-400 rounded"
            />
            <span>Telemetry</span>
          </label>

          <span className="text-white/20">|</span>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={layerDataFlows}
              onChange={(e) => {
                setLayerDataFlows(e.target.checked);
                if (mapRef.current) {
                  const visibility = e.target.checked ? "visible" : "none";
                  if (mapRef.current.getLayer("data-flows-line")) {
                    mapRef.current.setLayoutProperty("data-flows-line", "visibility", visibility);
                  }
                }
              }}
              className="accent-cyan-400 rounded"
            />
            <span>Data Flows</span>
          </label>

          <span className="text-white/20">|</span>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={performanceMode}
              onChange={(e) => setPerformanceMode(e.target.checked)}
              className="accent-amber-400 rounded"
            />
            <span className={performanceMode ? "text-amber-400 font-bold" : ""}>Performance</span>
          </label>
        </div>
      </div>

      {/* Offline Basemap Notice if OpenFreeMap tiles fail */}
      {basemapOfflineNotice && (
        <div className="absolute top-16 right-4 z-20 flex items-center gap-2 bg-amber-500/20 backdrop-blur-md border border-amber-500/40 text-amber-300 text-xs px-3.5 py-1.5 rounded-xl shadow-lg">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>Detailed basemap unavailable — operating on offline vector telemetry</span>
        </div>
      )}

      {/* Bottom Bar: Facility Cutaway Legend & Instructions */}
      <div className="absolute bottom-4 left-4 z-20 flex items-center gap-4 text-[10px] text-white/70 backdrop-blur-md bg-black/50 px-3.5 py-2 rounded-xl border border-white/10 font-mono">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]" />
          Nominal Facility
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
          Active Tampering
        </span>
        <span className="text-white/30">•</span>
        <span>Click facility to inspect exploded 3D building cutaway & rack tiers</span>
      </div>
    </div>
  );
}
