"""
Export trained MafiaPolicy to ONNX format for Node.js inference.

Usage:
    python training/export_onnx.py
    python training/export_onnx.py --checkpoint training/checkpoints/policy_final.pt
"""

import argparse
import sys
import torch
import torch.nn as nn
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from model import MafiaPolicy, OBS_DIM, TOTAL_MASK_DIM


class OnnxWrapper(nn.Module):
    """Wrapper that returns flat tensors instead of dict (ONNX can't export dicts)."""

    def __init__(self, policy):
        super().__init__()
        self.policy = policy

    def forward(self, obs, action_mask):
        probs, value = self.policy(obs, action_mask, ground_truth=None)
        return (
            probs["target"],       # [B, 19]
            probs["chat_type"],    # [B, 5]
            probs["chat_target"],  # [B, 19]
            probs["claim_role"],   # [B, 20]
            value,                 # [B, 1]
        )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", type=str, default="training/checkpoints/policy_final.pt")
    p.add_argument("--output", type=str, default="training/mafia_policy.onnx")
    p.add_argument("--hidden", type=int, default=None, help="Override hidden size")
    args = p.parse_args()

    # Load checkpoint to get hidden size
    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    ckpt_args = ckpt.get("args", {})
    hidden = args.hidden or ckpt_args.get("hidden", 128)

    print(f"Loading checkpoint: {args.checkpoint}")
    print(f"Hidden size: {hidden}")

    policy = MafiaPolicy(hidden=hidden)
    policy.load_state_dict(ckpt["policy_state_dict"])
    policy.eval()

    wrapper = OnnxWrapper(policy)
    wrapper.eval()

    # Dummy inputs
    dummy_obs = torch.randn(1, OBS_DIM)
    dummy_mask = torch.ones(1, TOTAL_MASK_DIM)

    print(f"Exporting to ONNX: {args.output}")
    torch.onnx.export(
        wrapper,
        (dummy_obs, dummy_mask),
        args.output,
        opset_version=18,
        input_names=["obs", "action_mask"],
        output_names=["target_probs", "chat_type_probs", "chat_target_probs", "claim_role_probs", "value"],
        dynamic_axes={
            "obs": {0: "batch"},
            "action_mask": {0: "batch"},
            "target_probs": {0: "batch"},
            "chat_type_probs": {0: "batch"},
            "chat_target_probs": {0: "batch"},
            "claim_role_probs": {0: "batch"},
            "value": {0: "batch"},
        },
        dynamo=False,
    )

    # Verify
    import onnxruntime as ort
    sess = ort.InferenceSession(args.output)
    import numpy as np
    obs_np = np.random.randn(4, OBS_DIM).astype(np.float32)
    mask_np = np.ones((4, TOTAL_MASK_DIM), dtype=np.float32)
    outputs = sess.run(None, {"obs": obs_np, "action_mask": mask_np})
    print(f"\nVerification (batch=4):")
    names = ["target_probs", "chat_type_probs", "chat_target_probs", "claim_role_probs", "value"]
    for name, out in zip(names, outputs):
        print(f"  {name}: shape={out.shape}")

    print(f"\nExported successfully: {args.output}")
    print(f"File size: {Path(args.output).stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
