"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import type { NodeInventory, ServerResponse } from "@/lib/types";
import {
  TopologyNode,
  buildHolisticNodes,
  INITIAL_TOPOLOGY_NODES,
} from "@/lib/holisticData";

interface FloatingLabel {
  id: string;
  name: string;
  cluster: string;
  status: string;
  tampered: boolean;
  x: number;
  y: number;
  visible: boolean;
}

interface Holistic3DViewProps {
  nodes?: NodeInventory[];
  servers?: ServerResponse[];
  topologyNodes?: TopologyNode[];
  activeFilter?: "all" | "tampered" | "canary" | "cloud";
  simulatedTamperNodeId?: string | null;
  onSelectNode: (node: TopologyNode | null) => void;
  selectedNodeId?: string | null;
}

export function Holistic3DView({
  nodes = [],
  servers = [],
  topologyNodes,
  activeFilter = "all",
  simulatedTamperNodeId = null,
  onSelectNode,
  selectedNodeId = null,
}: Holistic3DViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<{
    node: TopologyNode;
    screenX: number;
    screenY: number;
  } | null>(null);

  // Floating rooftop labels projected in 2D space above 3D buildings
  const [floatingLabels, setFloatingLabels] = useState<FloatingLabel[]>([]);

  // References for Three.js state
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const nodesDataRef = useRef<TopologyNode[]>([]);
  const nodeMeshesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const shockwavesRef = useRef<THREE.Mesh[]>([]);
  const packetBeamsRef = useRef<{ mesh: THREE.Mesh; curve: THREE.LineCurve3 | THREE.QuadraticBezierCurve3; progress: number; speed: number }[]>([]);

  // Orbit control interaction state
  const isDraggingRef = useRef(false);
  const previousMousePositionRef = useRef({ x: 0, y: 0 });
  const cameraLookAtRef = useRef(new THREE.Vector3(0, 0, 0));
  const sphericalRef = useRef({
    radius: 54,
    theta: Math.PI / 4,
    phi: Math.PI / 3.2,
  });

  // Keep nodes synchronized with parent state
  useEffect(() => {
    if (topologyNodes && topologyNodes.length > 0) {
      nodesDataRef.current = topologyNodes;
    } else {
      nodesDataRef.current = buildHolisticNodes(nodes, servers);
    }
  }, [topologyNodes, nodes, servers]);

  // Main Three.js Scene Setup & Render Loop
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.fog = new THREE.FogExp2(0x060b13, 0.011);

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    cameraRef.current = camera;
    const updateCameraPos = () => {
      const { radius, theta, phi } = sphericalRef.current;
      camera.position.x = radius * Math.sin(phi) * Math.sin(theta);
      camera.position.y = radius * Math.cos(phi);
      camera.position.z = radius * Math.sin(phi) * Math.cos(theta);
      camera.lookAt(cameraLookAtRef.current);
    };
    updateCameraPos();

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    rendererRef.current = renderer;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // 4. Lights
    const ambientLight = new THREE.AmbientLight(0x2a3b5c, 2.0);
    scene.add(ambientLight);

    const coreLight = new THREE.PointLight(0x38bdf8, 3.8, 100);
    coreLight.position.set(0, 2, 0);
    scene.add(coreLight);

    const alertLight = new THREE.PointLight(0xef4444, 2.8, 80);
    alertLight.position.set(12, 6, -8);
    scene.add(alertLight);

    // 5. Starfield / Cyber dust
    const starCount = 950;
    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      starPositions[i] = (Math.random() - 0.5) * 240;
      starPositions[i + 1] = (Math.random() - 0.5) * 160;
      starPositions[i + 2] = (Math.random() - 0.5) * 240;
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0x64748b,
      size: 0.8,
      transparent: true,
      opacity: 0.65,
    });
    const starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);

    // 6. Cyber Grid Ground Floor
    const grid = new THREE.GridHelper(100, 50, 0x0284c7, 0x0f2942);
    grid.position.y = -10;
    scene.add(grid);

    // 7. Central Org Command Core (Digital Twin HQ Core)
    const coreGroup = new THREE.Group();
    scene.add(coreGroup);

    const coreInnerGeo = new THREE.IcosahedronGeometry(2.6, 1);
    const coreInnerMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.85,
      roughness: 0.2,
      metalness: 0.9,
      wireframe: true,
    });
    const coreInnerMesh = new THREE.Mesh(coreInnerGeo, coreInnerMat);
    coreGroup.add(coreInnerMesh);

    const coreGlowGeo = new THREE.SphereGeometry(1.8, 24, 24);
    const coreGlowMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.8,
    });
    const coreGlowMesh = new THREE.Mesh(coreGlowGeo, coreGlowMat);
    coreGroup.add(coreGlowMesh);

    // Central Orbital Rings
    const ringGeo1 = new THREE.TorusGeometry(3.8, 0.05, 16, 64);
    const ringMat1 = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 });
    const ring1 = new THREE.Mesh(ringGeo1, ringMat1);
    ring1.rotation.x = Math.PI / 3;
    coreGroup.add(ring1);

    const ringGeo2 = new THREE.TorusGeometry(4.6, 0.04, 16, 64);
    const ringMat2 = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.4 });
    const ring2 = new THREE.Mesh(ringGeo2, ringMat2);
    ring2.rotation.y = Math.PI / 4;
    ring2.rotation.x = -Math.PI / 4;
    coreGroup.add(ring2);

    // 8. Place 3D Real-World Building & Server Tower Structures
    const nodeMeshes = new Map<string, THREE.Object3D>();
    nodeMeshesRef.current = nodeMeshes;
    shockwavesRef.current = [];
    packetBeamsRef.current = [];

    const topology = nodesDataRef.current.length > 0 ? nodesDataRef.current : INITIAL_TOPOLOGY_NODES;
    const clusters = Array.from(new Set(topology.map((n) => n.cluster)));
    const clusterAngles: Record<string, number> = {};
    clusters.forEach((cl, i) => {
      clusterAngles[cl] = (i / clusters.length) * (Math.PI * 2);
    });

    const shockwaveGeo = new THREE.RingGeometry(1.2, 2.2, 32);
    const shockwaveMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });

    topology.forEach((node, idx) => {
      const clusterAngle = clusterAngles[node.cluster] ?? (idx * 0.7);
      const clusterRadius = 22;
      const subOffsetRadius = 5.5;
      const subAngle = (idx % 4) * (Math.PI / 2) + clusterAngle;

      const cx = Math.cos(clusterAngle) * clusterRadius;
      const cz = Math.sin(clusterAngle) * clusterRadius;
      const cy = Math.sin(idx * 1.3) * 2.0;

      const px = cx + Math.cos(subAngle) * subOffsetRadius;
      const pz = cz + Math.sin(subAngle) * subOffsetRadius;
      const py = cy + Math.sin(idx * 0.8) * 1.0;

      node.meshPosition = [px, py, pz];

      const buildingGroup = new THREE.Group();
      buildingGroup.position.set(px, py, pz);
      buildingGroup.userData = { nodeId: node.id, nodeData: node };

      const isTampered = node.tampered || simulatedTamperNodeId === node.id;
      const baseColor = isTampered ? 0xef4444 : node.status === "warning" ? 0xf59e0b : 0x10b981;

      // Real-World Building Architecture: Pedestal Foundation
      const pedestalGeo = new THREE.BoxGeometry(2.6, 0.4, 2.6);
      const pedestalMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.4,
        metalness: 0.8,
      });
      const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
      pedestal.position.y = -1.2;
      buildingGroup.add(pedestal);

      // Building Structure: Skyscraper / Tower / Data Vault
      let towerHeight = 3.6;
      let towerWidth = 1.8;
      if (node.type === "gateway") {
        towerHeight = 4.8;
        towerWidth = 1.6;
      } else if (node.type === "database" || node.type === "canary") {
        towerHeight = 3.2;
        towerWidth = 2.2;
      }

      const buildingGeo = new THREE.BoxGeometry(towerWidth, towerHeight, towerWidth);
      const buildingMat = new THREE.MeshStandardMaterial({
        color: baseColor,
        emissive: baseColor,
        emissiveIntensity: isTampered ? 0.85 : 0.4,
        roughness: 0.2,
        metalness: 0.85,
      });
      const buildingTower = new THREE.Mesh(buildingGeo, buildingMat);
      buildingTower.position.y = towerHeight / 2 - 1.0;
      buildingGroup.add(buildingTower);

      // Multi-tier floor lines / Server rack window bands
      const floorBands = 3;
      for (let f = 1; f <= floorBands; f++) {
        const bandGeo = new THREE.BoxGeometry(towerWidth + 0.08, 0.08, towerWidth + 0.08);
        const bandMat = new THREE.MeshBasicMaterial({
          color: isTampered ? 0xff4d4f : 0x38bdf8,
          transparent: true,
          opacity: 0.8,
        });
        const band = new THREE.Mesh(bandGeo, bandMat);
        band.position.y = -1.0 + (towerHeight / (floorBands + 1)) * f;
        buildingGroup.add(band);
      }

      // Rooftop Structure & Antenna Spire
      const roofDeckGeo = new THREE.BoxGeometry(towerWidth * 0.85, 0.3, towerWidth * 0.85);
      const roofDeckMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.9 });
      const roofDeck = new THREE.Mesh(roofDeckGeo, roofDeckMat);
      roofDeck.position.y = towerHeight - 1.0 + 0.15;
      buildingGroup.add(roofDeck);

      // Rooftop Antenna Spire
      const antennaGeo = new THREE.CylinderGeometry(0.04, 0.08, 1.8, 8);
      const antennaMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9 });
      const antenna = new THREE.Mesh(antennaGeo, antennaMat);
      antenna.position.y = towerHeight - 1.0 + 1.05;
      buildingGroup.add(antenna);

      // Antenna Tip Blinking Beacon
      const tipGeo = new THREE.SphereGeometry(0.12, 8, 8);
      const tipMat = new THREE.MeshBasicMaterial({
        color: isTampered ? 0xef4444 : 0x38bdf8,
      });
      const beaconTip = new THREE.Mesh(tipGeo, tipMat);
      beaconTip.position.y = towerHeight - 1.0 + 1.95;
      buildingGroup.add(beaconTip);

      // Expanding 3D Shockwave Rings on Tampered Buildings
      if (isTampered) {
        const shockwave = new THREE.Mesh(shockwaveGeo, shockwaveMat.clone());
        shockwave.rotation.x = Math.PI / 2;
        shockwave.position.y = -0.9;
        buildingGroup.add(shockwave);
        shockwavesRef.current.push(shockwave);

        // Vertical Incident Laser Beam
        const beamGeo = new THREE.CylinderGeometry(0.08, 0.2, 8, 8);
        const beamMat = new THREE.MeshBasicMaterial({
          color: 0xef4444,
          transparent: true,
          opacity: 0.75,
        });
        const beam = new THREE.Mesh(beamGeo, beamMat);
        beam.position.y = towerHeight + 2.5;
        buildingGroup.add(beam);
      }

      scene.add(buildingGroup);
      nodeMeshes.set(node.id, buildingGroup);

      // Telemetry Connection Line to Core
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(px * 0.45, (py + 4) * 0.5, pz * 0.45),
        new THREE.Vector3(px, py, pz)
      );

      const points = curve.getPoints(24);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({
        color: isTampered ? 0xef4444 : 0x0284c7,
        transparent: true,
        opacity: isTampered ? 0.7 : 0.3,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      scene.add(line);

      // Traveling Packet Beam
      const packetGeo = new THREE.SphereGeometry(0.22, 8, 8);
      const packetMat = new THREE.MeshBasicMaterial({
        color: isTampered ? 0xff4d4f : 0x38bdf8,
      });
      const packet = new THREE.Mesh(packetGeo, packetMat);
      scene.add(packet);
      packetBeamsRef.current.push({
        mesh: packet,
        curve,
        progress: Math.random(),
        speed: 0.004 + Math.random() * 0.003,
      });
    });

    // 9. Raycasting for Mouse Interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const onMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (isDraggingRef.current) {
        const deltaX = event.clientX - previousMousePositionRef.current.x;
        const deltaY = event.clientY - previousMousePositionRef.current.y;

        sphericalRef.current.theta -= deltaX * 0.008;
        sphericalRef.current.phi = Math.max(0.15, Math.min(Math.PI / 2.05, sphericalRef.current.phi - deltaY * 0.008));
        updateCameraPos();

        previousMousePositionRef.current = { x: event.clientX, y: event.clientY };
        return;
      }

      mouse.x = (x / rect.width) * 2 - 1;
      mouse.y = -(y / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const allMeshes: THREE.Object3D[] = [];
      nodeMeshes.forEach((group) => {
        allMeshes.push(...group.children);
      });

      const intersects = raycaster.intersectObjects(allMeshes);
      if (intersects.length > 0) {
        let rootGroup: THREE.Object3D | null = intersects[0].object;
        while (rootGroup && !rootGroup.userData?.nodeId) {
          rootGroup = rootGroup.parent;
        }
        if (rootGroup && rootGroup.userData?.nodeData) {
          container.style.cursor = "pointer";
          setHoveredNode({
            node: rootGroup.userData.nodeData as TopologyNode,
            screenX: x,
            screenY: y,
          });
          return;
        }
      }

      container.style.cursor = isDraggingRef.current ? "grabbing" : "grab";
      setHoveredNode(null);
    };

    const onMouseDown = (event: MouseEvent) => {
      isDraggingRef.current = true;
      previousMousePositionRef.current = { x: event.clientX, y: event.clientY };
      container.style.cursor = "grabbing";
    };

    const onMouseUp = (event: MouseEvent) => {
      isDraggingRef.current = false;
      container.style.cursor = "grab";

      const rect = container.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const allMeshes: THREE.Object3D[] = [];
      nodeMeshes.forEach((group) => {
        allMeshes.push(...group.children);
      });

      const intersects = raycaster.intersectObjects(allMeshes);
      if (intersects.length > 0) {
        let rootGroup: THREE.Object3D | null = intersects[0].object;
        while (rootGroup && !rootGroup.userData?.nodeId) {
          rootGroup = rootGroup.parent;
        }
        if (rootGroup && rootGroup.userData?.nodeData) {
          const selected = rootGroup.userData.nodeData as TopologyNode;
          onSelectNode(selected);

          const pos = rootGroup.position;
          cameraLookAtRef.current.copy(pos);
          updateCameraPos();
        }
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      sphericalRef.current.radius = Math.max(18, Math.min(95, sphericalRef.current.radius + event.deltaY * 0.04));
      updateCameraPos();
    };

    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    container.addEventListener("wheel", onWheel, { passive: false });

    // 10. Render Loop & 2D Projected Floating Labels Calculation
    let clock = new THREE.Clock();
    const tempVec = new THREE.Vector3();

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime();

      // Rotate Org Core
      coreInnerMesh.rotation.x = elapsedTime * 0.25;
      coreInnerMesh.rotation.y = elapsedTime * 0.35;
      ring1.rotation.z = elapsedTime * 0.4;
      ring2.rotation.z = -elapsedTime * 0.3;

      // Animate starfield drift
      starField.rotation.y = elapsedTime * 0.015;

      // Calculate Floating Rooftop Labels projected to 2D screen coordinates
      const currentLabels: FloatingLabel[] = [];
      nodeMeshes.forEach((buildingGroup, id) => {
        const nodeData = buildingGroup.userData.nodeData as TopologyNode;
        if (!nodeData) return;

        // Position on top of the rooftop antenna
        tempVec.set(
          buildingGroup.position.x,
          buildingGroup.position.y + 4.2,
          buildingGroup.position.z
        );
        tempVec.project(camera);

        const isVisible = tempVec.z < 1.0;
        const screenX = ((tempVec.x + 1) * width) / 2;
        const screenY = ((-tempVec.y + 1) * height) / 2;

        currentLabels.push({
          id: nodeData.id,
          name: nodeData.name,
          cluster: nodeData.cluster,
          status: nodeData.status,
          tampered: nodeData.tampered || simulatedTamperNodeId === nodeData.id,
          x: screenX,
          y: screenY,
          visible: isVisible,
        });

        // Pulsing scale if selected
        if (id === selectedNodeId) {
          buildingGroup.scale.setScalar(1.2);
        } else {
          buildingGroup.scale.setScalar(1.0);
        }
      });
      setFloatingLabels(currentLabels);

      // Animate Tamper Shockwave expansion
      shockwavesRef.current.forEach((shock) => {
        const currentScale = (elapsedTime * 1.4) % 3.0;
        shock.scale.set(1 + currentScale, 1 + currentScale, 1);
        const mat = shock.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.9 - currentScale * 0.3);
      });

      // Animate flowing Telemetry Packet Beams
      packetBeamsRef.current.forEach((beam) => {
        beam.progress = (beam.progress + beam.speed) % 1;
        const pt = beam.curve.getPoint(beam.progress);
        beam.mesh.position.copy(pt);
      });

      renderer.render(scene, camera);
    };

    animate();

    // 11. Handle Container Resize
    const handleResize = () => {
      if (!container) return;
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;
      if (newWidth && newHeight) {
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(newWidth, newHeight);
      }
    };
    window.addEventListener("resize", handleResize);

    // 12. Cleanup on Unmount
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", handleResize);

      renderer.dispose();
      scene.clear();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [onSelectNode, selectedNodeId, simulatedTamperNodeId]);

  // Camera presets
  const handleResetOrbit = () => {
    sphericalRef.current = { radius: 54, theta: Math.PI / 4, phi: Math.PI / 3.2 };
    cameraLookAtRef.current.set(0, 0, 0);
    if (cameraRef.current) {
      const { radius, theta, phi } = sphericalRef.current;
      cameraRef.current.position.x = radius * Math.sin(phi) * Math.sin(theta);
      cameraRef.current.position.y = radius * Math.cos(phi);
      cameraRef.current.position.z = radius * Math.sin(phi) * Math.cos(theta);
      cameraRef.current.lookAt(cameraLookAtRef.current);
    }
  };

  const handleTopDown = () => {
    sphericalRef.current = { radius: 58, theta: 0, phi: 0.1 };
    cameraLookAtRef.current.set(0, 0, 0);
    if (cameraRef.current) {
      const { radius, theta, phi } = sphericalRef.current;
      cameraRef.current.position.x = radius * Math.sin(phi) * Math.sin(theta);
      cameraRef.current.position.y = radius * Math.cos(phi);
      cameraRef.current.position.z = radius * Math.sin(phi) * Math.cos(theta);
      cameraRef.current.lookAt(cameraLookAtRef.current);
    }
  };

  return (
    <div className="relative w-full h-[650px] bg-[#060b13] rounded-2xl overflow-hidden border border-outline-variant/20 shadow-2xl select-none">
      {/* 3D WebGL Canvas Mount */}
      <div ref={mountRef} className="w-full h-full cursor-grab" />

      {/* Floating 3D Rooftop Labels projected on top of each building */}
      {floatingLabels.map((lbl) => {
        if (!lbl.visible) return null;
        const isSelected = lbl.id === selectedNodeId;

        return (
          <div
            key={lbl.id}
            onClick={() => {
              const node = nodesDataRef.current.find((n) => n.id === lbl.id);
              if (node) onSelectNode(node);
            }}
            className={`absolute z-20 transform -translate-x-1/2 -translate-y-full cursor-pointer transition-all duration-75 pointer-events-auto ${
              lbl.tampered
                ? "scale-105"
                : isSelected
                ? "scale-110"
                : "opacity-85 hover:opacity-100 hover:scale-105"
            }`}
            style={{ left: lbl.x, top: lbl.y }}
          >
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold shadow-xl border backdrop-blur-md ${
                lbl.tampered
                  ? "bg-error/90 text-white border-white/40 shadow-error/40 animate-bounce"
                  : isSelected
                  ? "bg-primary text-white border-primary shadow-primary/30"
                  : "bg-[#0a1120]/85 text-white/90 border-white/10 hover:border-primary/50"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  lbl.tampered ? "bg-white animate-ping" : "bg-emerald-400"
                }`}
              />
              <span className="truncate max-w-[120px]">{lbl.name}</span>
              {lbl.tampered && <span className="text-[8px] bg-black/40 px-1 rounded uppercase">TAMPER</span>}
            </div>
            {/* Small pointer tick pointing to the rooftop */}
            <div className="w-0.5 h-2 bg-white/30 mx-auto" />
          </div>
        );
      })}

      {/* Floating 3D Hover Tooltip */}
      {hoveredNode && (
        <div
          className="absolute z-30 pointer-events-none transform -translate-x-1/2 -translate-y-full mb-3 bg-surface-container-highest/95 backdrop-blur-md px-3.5 py-2.5 rounded-xl border border-outline-variant/30 text-white shadow-xl min-w-[200px] transition-all"
          style={{ left: hoveredNode.screenX, top: hoveredNode.screenY }}
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-bold text-xs truncate text-primary">{hoveredNode.node.name}</span>
            <span
              className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider ${
                hoveredNode.node.tampered
                  ? "bg-error text-white animate-pulse"
                  : hoveredNode.node.status === "warning"
                  ? "bg-amber-500 text-black"
                  : "bg-emerald-500/20 text-emerald-400"
              }`}
            >
              {hoveredNode.node.tampered ? "🚨 TAMPERED" : hoveredNode.node.status}
            </span>
          </div>
          <div className="text-[10px] text-on-surface-variant font-mono space-y-0.5">
            <p>IP: <span className="text-white">{hoveredNode.node.ip}</span></p>
            <p>Facility: <span className="text-white">{hoveredNode.node.facility?.name || hoveredNode.node.region}</span></p>
            <p>Placement: <span className="text-primary-container">{hoveredNode.node.placement?.floorName} • {hoveredNode.node.placement?.rack}</span></p>
          </div>
          {hoveredNode.node.tampered && hoveredNode.node.tamperReason && (
            <div className="mt-1.5 pt-1.5 border-t border-error/30 text-[9px] text-error font-medium leading-tight">
              {hoveredNode.node.tamperReason}
            </div>
          )}
        </div>
      )}

      {/* 3D HUD Navigation Controls (Camera presets) */}
      <div className="absolute top-4 left-4 z-20 flex gap-2">
        <button
          onClick={handleResetOrbit}
          className="px-3 py-1.5 rounded-full text-xs font-semibold bg-surface-container-high/70 hover:bg-surface-container-high text-white backdrop-blur-md border border-white/10 transition-all flex items-center gap-1.5 shadow-lg"
        >
          <span>↺ Reset Orbit</span>
        </button>
        <button
          onClick={handleTopDown}
          className="px-3 py-1.5 rounded-full text-xs font-semibold bg-surface-container-high/70 hover:bg-surface-container-high text-white backdrop-blur-md border border-white/10 transition-all flex items-center gap-1.5 shadow-lg"
        >
          <span>⤓ Top-Down Grid</span>
        </button>
      </div>

      {/* Interaction Legend */}
      <div className="absolute bottom-4 left-4 z-20 text-[10px] text-on-surface-variant/70 backdrop-blur-md bg-black/40 px-3 py-1.5 rounded-lg border border-white/5 font-mono">
        Drag: Orbit rotate • Scroll: Zoom in/out • Click building / rooftop label: Forensics HUD
      </div>

      {/* Live 3D Mesh Legend */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-3 backdrop-blur-md bg-black/50 px-3.5 py-1.5 rounded-full border border-white/10 text-[10px] font-bold uppercase tracking-wider text-white">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]" />
          Healthy Building
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_#f59e0b]" />
          Suspicious
        </span>
        <span className="flex items-center gap-1.5 text-error">
          <span className="w-2 h-2 rounded-full bg-error animate-ping" />
          Active Tampering
        </span>
      </div>
    </div>
  );
}
