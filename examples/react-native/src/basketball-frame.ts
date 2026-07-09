import {
  DetectionMaskEncoding,
  type DetectionFrame,
  resolveDetectionClassColorStyle,
} from "supervision-js-react-native";

export const basketballFrameMetadata = {
  frameIndex: 0,
  height: 1080,
  mediaTime: 0,
  width: 1920,
} as const;

export const basketballDetectionFrame: DetectionFrame = {
  detections: [
    {
      className: "white team player",
      confidence: 0.95,
      id: "white-0",
      mask: {
        counts:
          "\\Re`04bQ14M2N2O0O2N100O1O100O1O010mKDiVO=fd0Ai[O5_O;cd0Kg[OKD<_d06e[O@J;_d0<`[O[ObM5d05Yf0=S[OPOPM9l0b0?Haf0`0P[OSOoL5n0j09@if0`0nZODoMc02\\OPg0?lZODoMh0OVOUg0a0kZOAQNn0GSO]g0>jZOBoMU1@POfg0;jZO@nMf2Xg0kMhZO@lMh2\\g0jMfZO_OkMj2_g0hMeZO]OiMo2ag0fMdZO\\OhMP3eg0eMaZO[OfMU3ig0bMZXOcN]1f0^NY3jg0`MXXOjNW1o4af0^MkXOk2Ug0YMcXOj2^g0h300000O1000000cNWXOjHkg0Q7_XOiHag0n5TXORJc0LYg0Q6]XOfIa06Sg0S6RZOjIoe0T6TZOiIne0U6VZOgIke0X6XZOeIje0Z6YZObIie0]6j2N3N3L5K;F6I5K5K3L3M2N3M2N3M2O2M201N2N101O0100000001N2O1O3M3M4L6J5K1O001O010O1^UOeJdh0\\5XWOgJih0Y5SWOiJnh0W5oVOlJRi0T5jVOnJWi0S5dVOPK^i0P5]VOSKdi0n4WVOUKji0l4lUO\\KWj0d4cUO_K_j0l52N2N2N3M2N2M3N3M3L4L3N4K4L3M2M4ZNYTOTMkk0g2\\TOSMhk0h2`TOPMek0l2bTOiLfk0R3d1H7F;D;@a0dN[1ITU^Z1",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 1080,
        width: 1920,
      },
      rect: { height: 319, width: 127, x: 505, y: 158 },
    },
    {
      className: "yellow team player",
      confidence: 0.95,
      id: "yellow-0",
      mask: {
        counts:
          "UPc71aQ1;F8H7K4I8I6L3N3M2O2N1O2O00000000O10000O1M4M2L5L4L5L3M3M3M2N2N3N1N110O10O10O01001O1O1O4K3N2NROKZPO3do00^PON_o05m05M3L5K4N1N3M3L4I7J5M4K6L3L4N2N2M3O1N3M2N2N2N2N2N2N2M3L4L4M3L4N2N3L3N2N3M2O1M3M3N2M3O1O1OO2O00000010O000010O`UOmK\\g0T4]XOWL^g0i3^XO]Lag0c3\\XObLag0_3]XOcLcg0]3]XOdLag0]3^XOdLbg0]3\\XOeLbg0\\3^XOdLbg0]3\\XOeLbg0]3]XOcLcg0_3ZXOcLeg0_3XXObLgg0b3UXO_Lkg0b3QXObLmg0`3oWOcLQh0^3jWOfLVh0[3eWOjLZh0V3bWOnL^h0S3]WOQMbh0R3UWOVMjh0m2mVOYMSi0l2eVOWM[i0d5N100OnNfVOhIgh0@WWOg69eI]h0n6fWOPIXh0Q7jWOoHTh0Q7nWOnHQh0Q7SXOlHmg0T7UXOkHkg0S7WXOmHhg0R7[XOmHdg0S7^XOlHbg0S7_XOmHag0P7cXOnH]g0Q7fXOnHZg0P7iXOmHYg0Q7h1N2N2N2nL\\UOmNgj0Q1^UOdNjj0Z1\\UO`Nfj0_1^UO[Nej0d1cUO_MSk0_2ZUOoLmj0P3o1M2N3L3L5K4M4M3M3N2N2N3M2N7I7I:F6K2M2N2O0110O001O0O2O101N1000001O01O1N3N100O01O00O104L2NO100O3ooNnNUo0V1aPOPO_o0e12M2O1O0O3O15NK5J<E4K4L4K4K5L5J7HkR_`1",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 1080,
        width: 1920,
      },
      rect: { height: 291, width: 219, x: 230, y: 204 },
    },
    {
      className: "basketball",
      confidence: 0.82,
      id: "ball-0",
      mask: {
        counts:
          "[ZP91cQ18I6K4M3L5L2M3N2N1O2O00001O0O2O001O01O000001O00000000000000O1000000000000O2O000O101O0O101N1O3L3N5I`ncd1",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 1080,
        width: 1920,
      },
      rect: { height: 42, width: 50, x: 273, y: 384 },
    },
  ],
  frameIndex: basketballFrameMetadata.frameIndex,
  mediaTime: basketballFrameMetadata.mediaTime,
};

export function colorForClass(className: string) {
  return resolveDetectionClassColorStyle(className).fill;
}
