import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

function chooseWideLens(lenses = []) {
  if (!Array.isArray(lenses) || lenses.length === 0) return undefined;

  const normalized = lenses.map((lens) => String(lens));

  const ultra = normalized.find((lens) => lens.toLowerCase().includes('ultra'));
  if (ultra) return ultra;

  const wide = normalized.find((lens) => lens.toLowerCase().includes('wide'));
  if (wide) return wide;

  return normalized[0];
}

function formatCoordinate(value, positiveLabel, negativeLabel) {
  if (value == null) return '--';
  const label = value >= 0 ? positiveLabel : negativeLabel;
  return `${Math.abs(value).toFixed(6)}° ${label}`;
}

function escapeFfmpegText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');
}


function getFfmpegBindings() {
  try {
    // Carregamento opcional: evita crash no Expo Go (módulo nativo ausente).
    // eslint-disable-next-line global-require
    const ffmpeg = require('ffmpeg-kit-react-native');
    if (ffmpeg?.FFmpegKit && ffmpeg?.ReturnCode) {
      return ffmpeg;
    }
    return null;
  } catch (error) {
    return null;
  }
}

export default function App() {
  const cameraRef = useRef(null);
  const locationSubscriptionRef = useRef(null);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();

  const [selectedLens, setSelectedLens] = useState(undefined);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [locationPermissionGranted, setLocationPermissionGranted] = useState(false);
  const [coords, setCoords] = useState(null);

  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local',
    []
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!cameraPermission) return;

    if (!cameraPermission.granted) {
      requestCameraPermission();
    }
  }, [cameraPermission, requestCameraPermission]);

  useEffect(() => {
    if (!mediaPermission) return;

    if (!mediaPermission.granted) {
      requestMediaPermission();
    }
  }, [mediaPermission, requestMediaPermission]);

  useEffect(() => {
    let mounted = true;

    async function setupLocation() {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!mounted) return;

      if (permission.status !== 'granted') {
        setLocationPermissionGranted(false);
        return;
      }

      setLocationPermissionGranted(true);

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      if (mounted) {
        setCoords(current.coords);
      }

      locationSubscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 1000,
          distanceInterval: 1,
        },
        (position) => {
          setCoords(position.coords);
        }
      );
    }

    setupLocation();

    return () => {
      mounted = false;
      if (locationSubscriptionRef.current) {
        locationSubscriptionRef.current.remove();
        locationSubscriptionRef.current = null;
      }
    };
  }, []);

  function handleAvailableLensesChanged(event) {
    const nextLenses = event?.nativeEvent?.lenses ?? [];
    const lens = chooseWideLens(nextLenses);
    if (lens) setSelectedLens(lens);
  }

  async function saveVideoToDevice(videoUri) {
    const permission = mediaPermission?.granted
      ? mediaPermission
      : await requestMediaPermission();

    if (!permission?.granted) {
      Alert.alert('Permissão necessária', 'Permita acesso à galeria para salvar o vídeo no dispositivo.');
      return;
    }

    const asset = await MediaLibrary.createAssetAsync(videoUri);
    await MediaLibrary.createAlbumAsync('Gravei', asset, false).catch(() => {});

    Alert.alert('Gravação finalizada', `Vídeo salvo no dispositivo com sucesso.\nURI: ${videoUri}`);
  }

  async function burnOverlayWithFfmpeg(inputUri, shotTimestamp, shotCoords) {
    const ffmpeg = getFfmpegBindings();
    if (!ffmpeg) {
      throw new Error('FFmpeg indisponível neste runtime (use Dev Build para habilitar).');
    }

    const { FFmpegKit, ReturnCode } = ffmpeg;
    const outputUri = `${FileSystem.cacheDirectory}gravei_overlay_${Date.now()}.mp4`;

    const timestampLine = `Data/Hora: ${shotTimestamp} (${timezone})`;
    const gpsLine = `GPS: ${shotCoords}`;

    const drawTimestamp = `drawtext=text='${escapeFfmpegText(timestampLine)}':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.55:boxborderw=8:x=24:y=24`;
    const drawGps = `drawtext=text='${escapeFfmpegText(gpsLine)}':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.55:boxborderw=8:x=24:y=74`;

    const command = `-y -i "${inputUri}" -vf "${drawTimestamp},${drawGps}" -c:a copy "${outputUri}"`;

    const session = await FFmpegKit.execute(command);
    const returnCode = await session.getReturnCode();

    if (ReturnCode.isSuccess(returnCode)) {
      return outputUri;
    }

    const failStack = await session.getFailStackTrace();
    console.warn('FFmpeg falhou ao aplicar overlay:', failStack);
    throw new Error('Falha no processamento FFmpeg');
  }

  async function handleRecordButtonPress() {
    if (!cameraRef.current || isProcessing) return;

    if (isRecording) {
      cameraRef.current.stopRecording();
      return;
    }

    try {
      setIsRecording(true);
      const videoResult = await cameraRef.current.recordAsync();

      if (!videoResult?.uri) {
        Alert.alert('Gravação finalizada', 'Vídeo gravado, mas não foi possível identificar a URI do arquivo.');
        return;
      }

      setIsProcessing(true);
      const shotTimestamp = new Date().toLocaleString('pt-BR', {
        hour12: false,
        timeZone: timezone,
      });
      const shotCoords = `${formatCoordinate(coords?.latitude, 'N', 'S')}, ${formatCoordinate(
        coords?.longitude,
        'E',
        'W'
      )}`;

      let outputUri = videoResult.uri;

      try {
        outputUri = await burnOverlayWithFfmpeg(videoResult.uri, shotTimestamp, shotCoords);
      } catch (ffmpegError) {
        Alert.alert(
          'Aviso de processamento',
          'FFmpeg não está disponível nesse ambiente (ex.: Expo Go). O arquivo original será salvo. Para burn-in use Dev Build.'
        );
      }

      await saveVideoToDevice(outputUri);
    } catch (error) {
      Alert.alert('Erro ao gravar', 'Não foi possível iniciar ou finalizar a gravação.');
    } finally {
      setIsRecording(false);
      setIsProcessing(false);
    }
  }

  const localTimestamp = new Date(now).toLocaleString('pt-BR', {
    hour12: false,
    timeZone: timezone,
  });

  const latitudeLabel = formatCoordinate(coords?.latitude, 'N', 'S');
  const longitudeLabel = formatCoordinate(coords?.longitude, 'E', 'W');

  if (!cameraPermission) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.statusText}>Carregando permissões da câmera...</Text>
      </SafeAreaView>
    );
  }

  if (!cameraPermission.granted) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.statusText}>
          Permissão da câmera não concedida. Autorize para continuar.
        </Text>
      </SafeAreaView>
    );
  }

  const buttonLabel = isProcessing ? 'PROCESSANDO' : isRecording ? 'GRAVANDO' : 'GRAVAR';

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode="video"
        selectedLens={selectedLens}
        onAvailableLensesChanged={handleAvailableLensesChanged}
      />

      <SafeAreaView style={styles.overlay}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Horário local: {localTimestamp}</Text>
          <Text style={styles.badgeText}>Fuso atual: {timezone}</Text>
          <Text style={styles.badgeText}>GPS: {latitudeLabel}, {longitudeLabel}</Text>
          <Text style={styles.badgeText}>Precisão: {coords?.accuracy ? `${Math.round(coords.accuracy)}m` : '--'}</Text>
          <Text style={styles.badgeText}>Lente: {selectedLens ?? 'padrão traseira'}</Text>
          {!locationPermissionGranted && (
            <Text style={styles.warningText}>GPS sem permissão: coordenadas indisponíveis.</Text>
          )}
        </View>

        {(isRecording || isProcessing) && (
          <View style={styles.recordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>{isProcessing ? 'PROCESSANDO' : 'GRAVANDO'}</Text>
          </View>
        )}
      </SafeAreaView>

      <View style={styles.recordButtonWrapper} pointerEvents="box-none">
        <TouchableOpacity
          onPress={handleRecordButtonPress}
          style={[styles.recordButton, (isRecording || isProcessing) && styles.recordButtonActive]}
          accessibilityRole="button"
          accessibilityLabel={isRecording ? 'Parar gravação' : 'Iniciar gravação'}
          disabled={isProcessing}
        >
          <Text style={styles.recordButtonText}>{buttonLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    flex: 1,
    padding: 16,
    justifyContent: 'space-between',
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  warningText: {
    color: '#fca5a5',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  recordingIndicator: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(153, 27, 27, 0.85)',
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 8,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ef4444',
  },
  recordingText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  recordButtonWrapper: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 34,
  },
  recordButton: {
    width: 108,
    height: 108,
    borderRadius: 54,
    backgroundColor: '#dc2626',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  recordButtonActive: {
    backgroundColor: '#b91c1c',
    transform: [{ scale: 0.96 }],
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: '#000',
  },
  statusText: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 16,
  },
});
