class Strategy:
    def __init__(self):
        self.position = 0
    def on_tick(self, bar):
        return "HOLD"